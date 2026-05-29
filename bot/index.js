'use strict';
require('dotenv').config();

const express   = require('express');
const fetch     = require('node-fetch');
const path      = require('path');
const { Pool }  = require('pg');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/fonts',  express.static(path.join(__dirname, 'public/fonts')));

// P1 Bot Без #2: CORS с явным allowlist методов и заголовков.
// Без ALLOWED_ORIGINS в .env разрешает Telegram WebApp origin (t.me / web.telegram.org).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_ORIGINS = ['https://web.telegram.org', 'https://t.me'];

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.length
    ? ALLOWED_ORIGINS.includes(origin)
    : TELEGRAM_ORIGINS.includes(origin) || !origin; // без origin — same-origin или non-browser
  if (allowed) {
    res.header('Access-Control-Allow-Origin',   origin || '*');
    res.header('Access-Control-Allow-Methods',  'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers',  'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 10,  standardHeaders: true, legacyHeaders: false });
const stockLimiter = rateLimit({ windowMs: 60 * 1000, max: 30,  standardHeaders: true, legacyHeaders: false });
const hhLimiter    = rateLimit({ windowMs: 60 * 1000, max: 60,  standardHeaders: true, legacyHeaders: false });

const BOT_TOKEN        = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN        || '').trim();
const ADMIN_ID         = (process.env.ADMIN_ID         || '').trim();
const DELIVERY_CHAT_ID = (process.env.DELIVERY_CHAT_ID || '').trim();
const PREORDER_CHAT_ID  = (process.env.PREORDER_CHAT_ID  || '').trim();
const WEBHOOK_SECRET    = (process.env.WEBHOOK_SECRET    || '').trim();
const PORT              = process.env.PORT || 3000;

// ─── Состояние (память + PostgreSQL) ─────────────────────────────────────────
const store  = new Map();
const cbSeen = new Map(); // id → timestamp; pruned hourly
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  cbSeen.forEach((ts, id) => { if (ts < cutoff) cbSeen.delete(id); });
}, 60 * 60 * 1000);

const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pgPool) {
    console.warn('DATABASE_URL not set — state stored in memory only (lost on restart)');
    return;
  }

  // bot_state — обязательная таблица
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key   VARCHAR(512) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  } catch(e) { console.error('CREATE bot_state:', e.message); }

  // Загружаем состояние
  try {
    const res = await pgPool.query('SELECT key, value FROM bot_state');
    res.rows.forEach(row => store.set(row.key, row.value));
    console.log(`PostgreSQL state loaded: ${store.size} keys`);
  } catch(e) { console.error('load bot_state:', e.message); }

  // Логируем все таблицы и колонки
  try {
    const tables = await pgPool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type='BASE TABLE'
        AND table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY table_schema, table_name
    `);
    for (const t of tables.rows) {
      const cols = await pgPool.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position
      `, [t.table_schema, t.table_name]);
      console.log(`TABLE [${t.table_schema}.${t.table_name}]:`, cols.rows.map(c => `${c.column_name}(${c.data_type})`).join(', '));
    }
  } catch(e) { console.error('list tables:', e.message); }
}

const CATALOG = [
  { name: 'Круассан Французский',   price: 3.50 },
  { name: 'Пончик Глазированный',   price: 2.20 },
  { name: 'Макарон Малина',          price: 4.50 },
  { name: 'Багет Французский',       price: 2.95 },
  { name: 'Хлеб Чёрный',            price: 2.10 },
  { name: 'Хлеб Пшеничный',         price: 1.80 },
  { name: 'Хлеб Цельнозерновой',    price: 3.20 },
  { name: 'Пирог с Ягодами',        price: 9.50 },
  { name: 'Пирог с Курицей',        price: 19.20 },
  { name: 'Пирог Яблочный',         price: 8.30 },
  { name: 'Пирог Рыбный',           price: 16.50 },
  { name: 'Торт Орео',              price: 73.00 },
  { name: 'Торт Молочный',          price: 35.00 },
  { name: 'Торт Шоколадный',        price: 52.00 },
  { name: 'Торт Ягодный',           price: 58.00 },
  { name: 'Перепечи с Сыром',       price: 2.50 },
  { name: 'Сосиска в Тесте',        price: 1.85 },
  { name: 'Хачапури',               price: 2.10 },
  { name: 'Пирожок с Мясом',        price: 1.75 },
  { name: 'Эчпочмак',               price: 2.10 },
  { name: 'Слойка с Грибами',       price: 3.20 },
  { name: 'Пицца Ветчина',          price: 3.90 },
  { name: 'Кальцоне',               price: 2.90 },
  { name: 'Пицца Пепперони',        price: 4.20 },
  { name: 'Пицца Овощная',          price: 3.50 },
  { name: 'Капучино',               price: 3.00 },
  { name: 'Латте',                  price: 3.20 },
  { name: 'Американо',              price: 2.50 },
  { name: 'Макиято',                price: 3.30 },
  { name: 'Кейк-попсы',             price: 4.50 },
  { name: 'Эклер шоколадный',       price: 3.50 },
  { name: 'Творожное кольцо',       price: 2.80 },
  { name: 'Медовик',                price: 3.90 },
  { name: 'Молочный десерт',        price: 3.20 },
  { name: 'Красный Бархат',         price: 4.80 },
  { name: 'Капкейк Клубника',       price: 3.50 },
  { name: 'Эклер клубничный',       price: 3.50 },
  { name: 'Тарт лимонный',          price: 4.20 },
  { name: 'Тарт карамель с орехами',price: 4.50 },
  { name: 'Тарт малина-фисташка',   price: 4.80 },
  { name: 'Трубочки со сгущёнкой',  price: 2.50 },
];

async function syncCatalogToWarehouse() {
  if (!pgPool) return;
  try {
    for (const item of CATALOG) {
      await pgPool.query(
        `INSERT INTO "Product" (name, stock, price)
         SELECT $1, 0, $2
         WHERE NOT EXISTS (SELECT 1 FROM "Product" WHERE name = $1)`,
        [item.name, item.price]
      );
    }
    console.log(`Product synced: ${CATALOG.length} items`);
  } catch(e) {
    console.error('syncCatalogToWarehouse:', e.message);
  }
}

// P2 #16: возвращает true/false — вызывающий код подтверждает запись перед выдачей чека
async function saveOrderToDB(body, isPreorder, total, orderNum, clientId) {
  if (!pgPool) return true; // БД не настроена (dev): не блокируем заказ, считаем «нечего терять»
  try {
    const items = typeof body.items === 'string' ? body.items : JSON.stringify(body.items || []);
    console.log('saveOrderToDB → Order', { name: body.name, phone: body.phone, total, isPreorder });
    await pgPool.query(
      `INSERT INTO "Order" ("orderNumber","customerName","phone","content","amount","status","address","isPreorder","telegramId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        String(orderNum),
        body.name    || 'Гость',
        body.phone   || null,
        items,
        parseFloat(total) || 0,
        'Новый',
        // P2 #6: встраиваем время самовывоза в поле address чтобы CRM мог показать pickupTime
        (() => {
          const addr = body.address || 'Самовывоз';
          const t = (body.time || '').trim();
          if (!isPreorder && addr === 'Самовывоз' && t) return `Самовывоз (${t})`;
          return addr;
        })(),
        isPreorder,
        clientId || '0'
      ]
    );
    console.log('saveOrderToDB ✓ saved to Order');
    return true;
  } catch(e) {
    console.error('saveOrderToDB FAILED:', e.message);
    console.error('  code:', e.code, '| detail:', e.detail);
    return false;
  }
}

function getProp(key) { return store.get(key) || null; }

function setProp(key, value) {
  store.set(key, value);
  if (pgPool) {
    pgPool.query(
      'INSERT INTO bot_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, String(value)]
    ).catch(e => console.error('setProp DB:', e.message));
  }
}

function delProp(key) {
  store.delete(key);
  if (pgPool) {
    pgPool.query('DELETE FROM bot_state WHERE key = $1', [key])
      .catch(e => console.error('delProp DB:', e.message));
  }
}

// Атомарный счётчик заказов (синхронный — без гонок в event loop Node.js)
function getNextOrderNum() {
  const n = parseInt(getProp('order_counter') || '0') + 1;
  setProp('order_counter', String(n));
  return n;
}

// P2 #15: разбор времени предзаказа "YYYY-MM-DD в HH:MM" с явной валидацией формата.
// Возвращает { valid, niceDate, rawTime }; при некорректном формате пишет warning,
// а не молча кладёт битый блок в сообщение.
function parsePreorderTime(timeStr) {
  const str = String(timeStr || '').trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+в\s+(\d{2}:\d{2})$/);
  if (!m) {
    console.warn(`parsePreorderTime: неожиданный формат времени предзаказа: ${JSON.stringify(str)}`);
    const parts = str.split(' в ');
    return { valid: false, niceDate: parts[0] || '—', rawTime: parts[1] || '—' };
  }
  return { valid: true, niceDate: `${m[3]}.${m[2]}.${m[1]}`, rawTime: m[4] };
}

// ─── Telegram API ─────────────────────────────────────────────────────────────
const TG_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// P1 #10: AbortController с 10-секундным таймаутом — зависание Telegram API
// не держит весь async flow сервера бесконечно.
async function tg(method, payload, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TG_BASE}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctrl.signal
    });
    return res.json();
  } catch(e) {
    if (e.name === 'AbortError') {
      console.error(`tg(${method}): timeout after ${timeoutMs}ms`);
    } else {
      console.error(`tg(${method}):`, e.message);
    }
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function tgAll(calls) {
  return Promise.all(calls.map(([method, payload]) => tg(method, payload)));
}

// ─── Дедупликация заказов ─────────────────────────────────────────────────────
function verifyTgInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected  = crypto.createHmac('sha256', secretKey).update(dataCheckStr).digest('hex');
    if (hash !== expected) return null;
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : {};
  } catch(e) { return null; }
}

function isDuplicateOrder(body) {
  const raw = String(body.items || '').replace(/\s+/g, '').slice(0, 80);
  const key = `dup_${body.phone}_${String(body.total)}_${raw}`;
  const now = Date.now();
  const last = parseInt(getProp(key) || '0');
  if (last && now - last < 20000) return true;
  setProp(key, String(now));
  return false;
}

// ─── Обработка заказа ─────────────────────────────────────────────────────────
async function handleOrder(body) {
  if (isDuplicateOrder(body)) { console.log('Duplicate order ignored'); return { ok: true, duplicate: true }; }
  const isPreorder = body.type === 'Предзаказ';

  // P1 #2: Верифицируем Telegram initData; fallback на body.telegramId (для совместимости)
  let clientId = '0';
  if (body.initData && BOT_TOKEN) {
    const tgUser = verifyTgInitData(body.initData, BOT_TOKEN);
    if (tgUser && tgUser.id) {
      clientId = String(tgUser.id);
    } else {
      console.warn('handleOrder: initData verification failed (hash mismatch or missing user)');
    }
  } else if (body.telegramId && body.telegramId !== '0') {
    clientId = String(body.telegramId);
  }
  const clientName = body.name || 'Гость';

  // P0 #5: Серверные цены из CATALOG — клиентский total игнорируется
  const catalogPriceMap = {};
  CATALOG.forEach(p => { catalogPriceMap[p.name.toLowerCase()] = p.price; });

  let itemsText = '';
  let total = 0;
  try {
    const parsed = typeof body.items === 'string' ? JSON.parse(body.items) : body.items;
    if (Array.isArray(parsed)) {
      itemsText = parsed.flatMap(i => {
        const name = (i.product_name || '').trim();
        const qty  = Math.floor(Number(i.quantity));
        if (!name || !Number.isFinite(qty) || qty <= 0) return [];
        const serverPrice = catalogPriceMap[name.toLowerCase()];
        const clientPrice = Number(i.price);
        const price = (serverPrice !== undefined) ? serverPrice
          : (isNaN(clientPrice) || clientPrice <= 0 ? 0 : clientPrice);
        if (serverPrice === undefined) console.warn(`handleOrder: unknown product "${name}", using client price`);
        total += price * qty;
        return [`◆ ${name} x${qty} — ${(price * qty).toFixed(2)} Br`];
      }).join('\n');
    } else {
      itemsText = String(body.items || '');
    }
  } catch(e) {
    itemsText = String(body.items || '');
  }

  // Всегда используем серверный total; body.total от клиента игнорируется
  const totalStr = total.toFixed(2) + ' Br';

  let deliveryBlock = '';
  if (isPreorder && body.time && body.time !== 'undefined') {
    // P2 #15: валидируем формат "YYYY-MM-DD в HH:MM"
    const pt = parsePreorderTime(body.time);
    deliveryBlock = `*ПРЕДЗАКАЗ:*\n📅 Дата: ${pt.niceDate}\n🕐 Время: ${pt.rawTime}`;
  } else if (body.address && body.address !== 'undefined' && body.address !== 'Самовывоз') {
    const payLabel = body.payment === 'card' ? '💳 Картой' : body.payment === 'cash' ? '💵 Наличными' : '';
    deliveryBlock = `*АДРЕС ДОСТАВКИ:*\n🚕 ${body.address}${payLabel ? `\n${payLabel}` : ''}`;
  } else if (body.time && body.time !== 'undefined') {
    deliveryBlock = `*САМОВЫВОЗ:*\n📍 г. Витебск, ул. Ленина 74\n🕐 Время: ${body.time}`;
  } else {
    deliveryBlock = `*САМОВЫВОЗ:*\n📍 г. Витебск, ул. Ленина 74`;
  }

  const noteStr  = (body.note || '').trim();
  const noteLine = noteStr ? `\n💬 *ПРИМЕЧАНИЕ:* ${noteStr}\n` : '';

  const orderNum = getNextOrderNum();

  // P2 #16: подтверждаем запись заказа в БД ДО генерации чека/админ-сообщений.
  // Если запись не удалась — не выдаём номер заказа, который не существует в CRM
  // (предотвращает фантомные заказы и рассинхрон callback-ов статусов).
  const saved = await saveOrderToDB(body, isPreorder, total, orderNum, clientId);
  if (!saved) {
    console.error(`handleOrder: order #${orderNum} NOT persisted — aborting receipt/admin notifications`);
    return { ok: false, error: 'save_failed' };
  }

  const receiptBase =
    `🧾 *${isPreorder ? 'ВАШ ПРЕДЗАКАЗ' : 'ВАШ ЗАКАЗ'} №${orderNum}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 ${clientName}\n` +
    `📞 ${body.phone || '—'}\n` +
    `${deliveryBlock}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧺 *Состав:*\n${itemsText}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Итого:* ${totalStr}\n` +
    noteLine;

  const isDeliveryAddr = body.address && body.address !== 'Самовывоз' && body.address !== 'undefined';
  const orderType = isPreorder ? 'preorder'
    : (body.deliveryMethod === 'delivery' || isDeliveryAddr) ? 'delivery' : 'pickup';
  setProp(`order_type_${orderNum}`, orderType);
  console.log(`Order ${orderNum} type=${orderType}`);

  const orderTypeLabel = isPreorder ? 'ПРЕДЗАКАЗ' : orderType === 'delivery' ? 'ДОСТАВКА' : 'НОВЫЙ ЗАКАЗ';
  const adminHeader    = `🥐 *${orderTypeLabel} — №${orderNum}*`;
  const adminBody      =
    `\n*КЛИЕНТ:*\n` +
    `👤 ${clientName}\n` +
    `📞 ${body.phone || '—'}\n` +
    `\n${deliveryBlock}\n` +
    `\n*ПОЗИЦИИ:*\n` +
    `${itemsText}\n` +
    `━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n` +
    `💰 *Сумма заказа:* ${totalStr}` +
    noteLine;

  setProp(`receipt_base_${orderNum}`, receiptBase);
  setProp(`admin_base_${orderNum}`,   adminHeader);
  setProp(`admin_body_${orderNum}`,   adminBody);
  setProp(`client_name_${orderNum}`,  clientName);
  setProp(`order_num_${orderNum}`,    String(orderNum));
  setProp(`order_phone_${orderNum}`,  body.phone   || '—');
  setProp(`order_address_${orderNum}`,body.address || 'Самовывоз');
  setProp(`order_total_${orderNum}`,  totalStr);
  setProp(`order_payment_${orderNum}`,body.payment || '');
  setProp(`order_note_${orderNum}`,        noteStr);
  setProp(`order_items_text_${orderNum}`,  itemsText);

  // Запомнить клиента для happy hour уведомлений
  if (clientId !== '0') {
    const clientsRaw = getProp('known_clients') || '[]';
    let clients = [];
    try { clients = JSON.parse(clientsRaw); } catch(e) {}
    if (!clients.includes(clientId)) {
      clients.push(clientId);
      setProp('known_clients', JSON.stringify(clients));
    }
  }

  const calls = [];
  if (clientId !== '0') {
    calls.push(['sendMessage', {
      chat_id:    clientId,
      text:       receiptBase,
      parse_mode: 'Markdown'
    }]);
  }

  if (isPreorder && PREORDER_CHAT_ID) {
    const pt = parsePreorderTime(body.time); // P2 #15
    const niceDate = pt.niceDate;
    const rawTime  = pt.rawTime;
    const preorderText =
      `📌 *ПРЕДЗАКАЗ — №${orderNum}*\n🟡 Статус: Новый\n\n` +
      `👤 ${clientName}\n` +
      `📞 ${body.phone || '—'}\n` +
      `📅 ${niceDate}  🕐 ${rawTime}\n\n` +
      `*Состав:*\n${itemsText}\n\n` +
      `💰 ${totalStr}`;
    calls.push(['sendMessage', {
      chat_id:      PREORDER_CHAT_ID,
      text:         preorderText,
      parse_mode:   'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Принять заказ', callback_data: `accept_${orderNum}_${clientId}` },
        { text: '❌ Отклонить',     callback_data: `decline_${orderNum}_${clientId}` }
      ]]}
    }]);
  } else {
    calls.push(['sendMessage', {
      chat_id:      ADMIN_ID,
      text:         `${adminHeader}\n🟡 Статус: Новый${adminBody}`,
      parse_mode:   'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Принять заказ', callback_data: `accept_${orderNum}_${clientId}` },
        { text: '❌ Отклонить',     callback_data: `decline_${orderNum}_${clientId}` }
      ]]}
    }]);
  }

  const responses = await tgAll(calls);
  let offset = 0;

  if (clientId !== '0') {
    const r = responses[0];
    if (r.ok) setProp(`receipt_${orderNum}`,
      JSON.stringify({ chatId: clientId, msgId: r.result.message_id }));
    offset = 1;
  }

  const adminR = responses[offset];
  if (adminR?.ok) {
    const chatId = (isPreorder && PREORDER_CHAT_ID) ? PREORDER_CHAT_ID : ADMIN_ID;
    setProp(`admin_msg_${orderNum}`, JSON.stringify({ chatId, msgId: adminR.result.message_id }));
  }

  return { ok: true, orderNum };
}

// ─── Вспомогательные функции статусов ────────────────────────────────────────

async function editAdminMsg(adminChatId, adminMsgId, adminBase, statusLine, keyboard, adminBody) {
  return tg('editMessageText', {
    chat_id:      adminChatId,
    message_id:   adminMsgId,
    text:         `${adminBase}\n${statusLine}${adminBody || ''}`,
    parse_mode:   'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function notifyClient(clientId, text, keyboard) {
  if (!clientId || clientId === '0') return null;
  return tg('sendMessage', {
    chat_id:    String(clientId),
    text,
    parse_mode: 'Markdown',
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

async function deleteStoredMsg(key) {
  const raw = getProp(key);
  if (!raw) return;
  try {
    const info = JSON.parse(raw);
    await tg('deleteMessage', { chat_id: info.chatId, message_id: info.msgId });
  } catch(e) {
    console.error(`deleteStoredMsg(${key}):`, e.message);
  }
  delProp(key);
}

const RATING_KEYBOARD = [[
  { text: '1⭐', callback_data: 'rate_1_ROW' },
  { text: '2⭐', callback_data: 'rate_2_ROW' },
  { text: '3⭐', callback_data: 'rate_3_ROW' },
  { text: '4⭐', callback_data: 'rate_4_ROW' },
  { text: '5⭐', callback_data: 'rate_5_ROW' }
]];
function ratingKeyboard(rowNum) {
  return [RATING_KEYBOARD[0].map(b => ({ ...b, callback_data: b.callback_data.replace('ROW', rowNum) }))];
}

// ─── Ежедневный check-in администратора ──────────────────────────────────────
async function sendAdminCheckin() {
  const r = await tg('sendMessage', {
    chat_id:    ADMIN_ID,
    text:       `☀️ Доброе утро!\n\nКто сегодня работает администратором?\nВведите ваше имя:`,
    parse_mode: 'Markdown'
  });
  if (r.ok) {
    setProp(`pending_checkin_${ADMIN_ID}`, JSON.stringify({ promptMsgId: r.result.message_id }));
    setProp('checkin_msg', JSON.stringify({ chatId: ADMIN_ID, msgId: r.result.message_id }));
  }
}

// ─── Обработка кнопок ─────────────────────────────────────────────────────────
async function handleCallback(cb) {
  if (cbSeen.has(cb.id)) {
    await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '', show_alert: false });
    return;
  }
  cbSeen.set(cb.id, Date.now());

  const parts  = cb.data.split('_');
  const action = parts[0];

  if (action !== 'rate') {
    await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '', show_alert: false });
  }

  // ── Check-in администратора ───────────────────────────────────────────────
  if (action === 'checkin') {
    if (String(cb.from.id) !== ADMIN_ID) return;
    const r = await tg('sendMessage', {
      chat_id:    ADMIN_ID,
      text:       '✏️ Введите ваше имя:',
      parse_mode: 'Markdown'
    });
    setProp(`pending_checkin_${ADMIN_ID}`, JSON.stringify({ promptMsgId: r?.ok ? r.result.message_id : null }));
    const cm = getProp('checkin_msg');
    if (cm) {
      const { chatId, msgId } = JSON.parse(cm);
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    }
    return;
  }

  // ── Оценка звёздами ───────────────────────────────────────────────────────
  if (action === 'rate') {
    const stars     = parseInt(parts[1]);
    const ratingRow = parseInt(parts[2]);
    const starStr   = '⭐'.repeat(stars) + ` (${stars}/5)`;

    await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: starStr, show_alert: false });

    const existingRaw = getProp(`pending_${cb.from.id}`);
    if (existingRaw) {
      try {
        const ep = JSON.parse(existingRaw);
        if (ep.reviewReqMsgId) {
          setProp(`pending_${cb.from.id}`,
            JSON.stringify({ stars, rowNum: ratingRow, reviewReqMsgId: ep.reviewReqMsgId }));
          return;
        }
      } catch(e) {}
    }

    const [, reviewRes] = await tgAll([
      ['deleteMessage', { chat_id: String(cb.from.id), message_id: cb.message.message_id }],
      ['sendMessage', {
        chat_id:    String(cb.from.id),
        text:       `💬 *Оставьте ваш отзыв*\n\nВы оценили: ${starStr}\n\n_Напишите комментарий или_ /skip`,
        parse_mode: 'Markdown'
      }]
    ]);

    setProp(`pending_${cb.from.id}`, JSON.stringify({
      stars,
      rowNum:         ratingRow,
      reviewReqMsgId: reviewRes?.ok ? reviewRes.result.message_id : null
    }));
    return;
  }

  const rowNum      = parseInt(parts[1]);
  const clientId    = parts[2];
  const orderNum    = getProp(`order_num_${rowNum}`) || String(rowNum);
  const adminChatId = cb.message?.chat?.id || ADMIN_ID;
  const adminMsgId  = cb.message?.message_id;
  const adminBase   = getProp(`admin_base_${rowNum}`) || '';
  const adminBody   = getProp(`admin_body_${rowNum}`) || '';
  const orderType   = getProp(`order_type_${rowNum}`) || 'pickup';

  // ── 1. Принять ────────────────────────────────────────────────────────────
  if (action === 'accept') {
    await deleteStoredMsg(`decline_msg_${rowNum}`);
    await deleteStoredMsg(`restore_msg_${rowNum}`);

    await editAdminMsg(adminChatId, adminMsgId, adminBase, '🟢 Статус: Принят', [[
      { text: '✅ Готово',    callback_data: `ready_${rowNum}_${clientId}` },
      { text: '❌ Отменить', callback_data: `cancel_${rowNum}_${clientId}` }
    ]], adminBody);

    const acceptText = orderType === 'preorder'
      ? `☀️ *Доброе утро!*\n\nВаш заказ №${orderNum} принят! Мы уже готовим его для вас. 🍞`
      : `✅ *Ваш заказ №${orderNum} принят!*\n\n🍞 Мы уже приступаем к приготовлению. Сообщим о готовности!`;
    const r = await notifyClient(clientId, acceptText);
    if (r?.ok) setProp(`accept_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    return;
  }

  // ── 2. В работе ───────────────────────────────────────────────────────────
  if (action === 'working') {
    await deleteStoredMsg(`accept_msg_${rowNum}`);

    await editAdminMsg(adminChatId, adminMsgId, adminBase, 'Статус: 👨‍🍳 В работе', [[
      { text: '🍞 Готово', callback_data: `ready_${rowNum}_${clientId}` }
    ]], adminBody);

    const r = await notifyClient(clientId,
      `👨‍🍳 *Заказ №${orderNum} готовится!*\n\nМы уже работаем над вашим заказом. Скоро сообщим о готовности.`);
    if (r?.ok) setProp(`working_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    return;
  }

  // ── 3. Готов ──────────────────────────────────────────────────────────────
  if (action === 'ready') {
    await deleteStoredMsg(`accept_msg_${rowNum}`);
    await deleteStoredMsg(`working_msg_${rowNum}`);

    const isDeliveryOrder = orderType === 'delivery';

    if (isDeliveryOrder) {
      await editAdminMsg(adminChatId, adminMsgId, adminBase, 'Готов ✅', [[
        { text: '🚗 Отправить доставку', callback_data: `courier_${rowNum}_${clientId}` }
      ]], adminBody);
    } else {
      await editAdminMsg(adminChatId, adminMsgId, adminBase, 'Готов ✅', [], adminBody);
      const readyText = orderType === 'preorder'
        ? `🍞 *Ваш предзаказ №${orderNum} готов!*\n\n📍 Ждём вас по адресу: г. Витебск, ул. Ленина 74\n\nСпасибо, что выбрали нас! Желаем вам хорошего и продуктивного дня ☀️\n\n⭐ *Оцените качество обслуживания:*`
        : `🍞 *Ваш заказ №${orderNum} готов!*\n\n📍 Ждём вас по адресу: г. Витебск, ул. Ленина 74\n\n⭐ *Оцените качество обслуживания:*`;
      const r = await notifyClient(clientId, readyText, ratingKeyboard(rowNum));
      if (r?.ok) setProp(`done_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    }
    return;
  }

  // ── 4a. Передан курьеру (только доставка) ────────────────────────────────
  if (action === 'courier') {
    if (orderType !== 'delivery') {
      console.warn(`courier action for non-delivery order ${rowNum}, orderType=${orderType} — skipped`);
      return;
    }
    await deleteStoredMsg(`ready_msg_${rowNum}`);

    await editAdminMsg(adminChatId, adminMsgId, adminBase, '🚗 В доставке', [], adminBody);

    if (DELIVERY_CHAT_ID) {
      const phone   = getProp(`order_phone_${rowNum}`)   || '—';
      const address = getProp(`order_address_${rowNum}`) || '—';
      const total   = getProp(`order_total_${rowNum}`)   || '—';
      const name    = getProp(`client_name_${rowNum}`)   || '—';
      const payment = getProp(`order_payment_${rowNum}`) || '';
      const note    = getProp(`order_note_${rowNum}`)    || '';
      const payLabel = payment === 'card' ? '💳 Картой' : payment === 'cash' ? '💵 Наличными' : '';
      const deliveryText =
        `🚗 *ДОСТАВКА — №${orderNum}*\n\n` +
        `👤 ${name}\n` +
        `📞 ${phone}\n` +
        `📍 ${address}\n` +
        (payLabel ? `${payLabel}\n` : '') +
        `💰 ${total}` +
        (note ? `\n\n💬 *Примечание:* ${note}` : '');
      const dr = await tg('sendMessage', {
        chat_id:      DELIVERY_CHAT_ID,
        text:         deliveryText,
        parse_mode:   'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Доставлен', callback_data: `done_${rowNum}_${clientId}` }
        ]]}
      });
      if (dr?.ok) setProp(`delivery_msg_${rowNum}`, JSON.stringify({ chatId: DELIVERY_CHAT_ID, msgId: dr.result.message_id }));
    }

    await notifyClient(clientId,
      `🚗 *Заказ №${orderNum} отправлен!*\n\n⏱ Ориентировочное время доставки: *30–45 минут* в зависимости от загруженности.\nПо приезде заказа, курьер с вами свяжется!\n\nС уважением команда «Мамин Хлеб»\nЕсли возникли вопросы звоните по номеру:\n☎️ +375(29)722-20-22`);
    return;
  }

  // ── 4b. Доставлен ─────────────────────────────────────────────────────────
  if (action === 'done') {
    await deleteStoredMsg(`ready_msg_${rowNum}`);

    const deliveryMsgRaw = getProp(`delivery_msg_${rowNum}`);
    if (deliveryMsgRaw) {
      const dm = JSON.parse(deliveryMsgRaw);
      await tg('editMessageReplyMarkup', { chat_id: dm.chatId, message_id: dm.msgId, reply_markup: { inline_keyboard: [] } });
      delProp(`delivery_msg_${rowNum}`);
    }

    const adminMsgRaw = getProp(`admin_msg_${rowNum}`);
    const storedAdmin = adminMsgRaw ? JSON.parse(adminMsgRaw) : null;
    const targetChatId = storedAdmin ? storedAdmin.chatId : adminChatId;
    const targetMsgId  = storedAdmin ? storedAdmin.msgId  : adminMsgId;
    await editAdminMsg(targetChatId, targetMsgId, adminBase, '✅ Доставлен', [], adminBody);

    const r = await notifyClient(clientId,
      `🎉 *Ваш заказ №${orderNum} доставлен!*\n\nСпасибо, что выбрали нас! 🍞\n\n⭐ *Оцените качество обслуживания:*`,
      ratingKeyboard(rowNum));
    if (r?.ok) setProp(`done_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    return;
  }

  // ── 5. Отклонить / Отменить ───────────────────────────────────────────────
  if (action === 'decline' || action === 'cancel') {
    const label = action === 'cancel' ? 'Отменён' : 'Отклонён';
    const clientText = action === 'cancel'
      ? `🚫 *Ваш заказ №${orderNum} отменён.*\n\nПриносим извинения. Обратитесь к нам напрямую.`
      : `❌ *Ваш заказ №${orderNum} отклонён.*\n\nПриносим извинения. Свяжитесь с нами.`;

    await Promise.all([
      deleteStoredMsg(`accept_msg_${rowNum}`),
      deleteStoredMsg(`working_msg_${rowNum}`),
      deleteStoredMsg(`ready_msg_${rowNum}`)
    ]);

    await editAdminMsg(adminChatId, adminMsgId, adminBase, `Статус: ${label}`, [[
      { text: '↩️ Вернуть в работу', callback_data: `restore_${rowNum}_${clientId}` }
    ]], adminBody);

    const r = await notifyClient(clientId, clientText);
    if (r?.ok) setProp(`decline_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    return;
  }

  // ── 6. Вернуть в работу ───────────────────────────────────────────────────
  if (action === 'restore') {
    await deleteStoredMsg(`decline_msg_${rowNum}`);

    await editAdminMsg(adminChatId, adminMsgId, adminBase, '🟡 Статус: Новый', [[
      { text: '✅ Принять заказ', callback_data: `accept_${rowNum}_${clientId}` },
      { text: '❌ Отклонить',     callback_data: `decline_${rowNum}_${clientId}` }
    ]], adminBody);

    const r = await notifyClient(clientId,
      `🔄 *Ваш заказ №${orderNum} снова в обработке.*\n\nСкоро свяжемся с вами!`);
    if (r?.ok) setProp(`restore_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    delProp(`decline_msg_${rowNum}`);
    return;
  }
}

// ─── Обработка текстовых сообщений (check-in + отзыв) ────────────────────────
async function handleTextMessage(message) {
  const senderId = String(message.from.id);
  const msgText  = message.text.trim();

  const msgKey = `msg_${message.message_id}`;
  if (getProp(msgKey)) return;
  setProp(msgKey, '1');

  // ── Check-in администратора ───────────────────────────────────────────────
  const checkinRaw = senderId === ADMIN_ID ? getProp(`pending_checkin_${ADMIN_ID}`) : null;
  if (checkinRaw) {
    const cd = JSON.parse(checkinRaw);
    if (cd.promptMsgId) await tg('deleteMessage', { chat_id: senderId, message_id: cd.promptMsgId });
    await tg('sendMessage', {
      chat_id:    senderId,
      text:       `✅ Записано! Сегодня работает: *${msgText}*`,
      parse_mode: 'Markdown'
    });
    delProp(`pending_checkin_${senderId}`);
    return;
  }

  // ── Отзыв после оценки ────────────────────────────────────────────────────
  const pendingRaw = getProp(`pending_${senderId}`);
  if (!pendingRaw) return;

  const data   = JSON.parse(pendingRaw);
  const isSkip = msgText === '/skip';

  if (!isSkip && pgPool) {
    try {
      const rowNum = data.rowNum;
      await pgPool.query(
        `UPDATE "Order" SET review=$1, rating=$2 WHERE "orderNumber"=$3`,
        [msgText, data.stars || null, String(rowNum)]
      );
      console.log(`Review saved for order ${rowNum}`);
    } catch(e) {
      console.error('review DB save:', e.message);
    }
  }

  const calls = [];
  if (data.reviewReqMsgId) calls.push(['deleteMessage',
    { chat_id: senderId, message_id: data.reviewReqMsgId }]);
  calls.push(['sendMessage', {
    chat_id:    senderId,
    text:       isSkip ? '🙏 *Спасибо за оценку!* Рады видеть вас снова 🍞' : '🙏 *Спасибо за отзыв!*',
    parse_mode: 'Markdown'
  }]);

  await tgAll(calls);
  delProp(`pending_${senderId}`);
}

// ─── Маршруты ─────────────────────────────────────────────────────────────────

app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET) {
    const token = req.headers['x-telegram-bot-api-secret-token'];
    if (token !== WEBHOOK_SECRET) return res.sendStatus(403);
  }
  res.sendStatus(200);
  const body = req.body;
  if (!body) return;
  if (body.callback_query) {
    handleCallback(body.callback_query).catch(e => console.error('callback err:', e));
  } else if (body.message?.text) {
    handleTextMessage(body.message).catch(e => console.error('message err:', e));
  }
});

const VALID_ORDER_TYPES = new Set(['Предзаказ', 'Доставка', 'Самовывоз', '']);
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

app.post('/order', orderLimiter, async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {
      console.error('/order JSON parse failed:', e.message);
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
  }
  if (!body) return res.status(400).json({ ok: false, error: 'empty_body' });

  const phone = String(body.phone || '').trim();
  const name  = String(body.name  || '').trim();
  const type  = String(body.type  || '').trim();

  if (!phone || !PHONE_RE.test(phone)) {
    console.warn('/order rejected: missing or invalid phone', JSON.stringify(phone));
    return res.status(400).json({ ok: false, error: 'invalid_phone' });
  }
  if (!name) {
    console.warn('/order rejected: missing name');
    return res.status(400).json({ ok: false, error: 'missing_name' });
  }
  if (!VALID_ORDER_TYPES.has(type)) {
    console.warn('/order rejected: invalid type', JSON.stringify(type));
    return res.status(400).json({ ok: false, error: 'invalid_type' });
  }

  // P2 #12 (сервер): дожидаемся подтверждения записи заказа и отдаём клиенту реальный
  // результат, чтобы фронт не очищал корзину и не показывал чек при сбое.
  console.log('/order accepted, type:', type, 'name:', name, 'phone:', phone);
  try {
    const result = await handleOrder(body);
    if (result && result.ok) {
      return res.json({ ok: true, orderNum: result.orderNum });
    }
    return res.status(502).json({ ok: false, error: (result && result.error) || 'order_failed' });
  } catch(e) {
    console.error('order err:', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});


app.get('/api/stock', stockLimiter, async (req, res) => {
  if (!pgPool) {
    return res.json({ ok: false, error: 'db_unavailable', stock: {}, catalog: [], flags: {} });
  }
  try {
    const result = await pgPool.query('SELECT name, stock FROM "Product"');
    const stock = {};
    result.rows.forEach(r => { stock[r.name] = r.stock; });
    res.json({ ok: true, stock, catalog: CATALOG, flags: {} });
  } catch(e) {
    console.error('/api/stock DB error:', e.message);
    res.json({ ok: false, error: 'db_error', stock: {}, catalog: [], flags: {} });
  }
});

// P2 #13: happy hour статус по серверному времени (UTC+3, Минск)
app.get('/api/happyhour', hhLimiter, (req, res) => {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600_000);
  const day = msk.getUTCDay();
  const h   = msk.getUTCHours();
  const m   = msk.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  const weekend = day === 0 || day === 6;
  const active  = (weekday && h >= 19 && h < 20) || (weekend && h >= 17 && h < 18);
  const endH    = weekday ? 20 : 18;
  const minLeft = active ? (endH * 60) - (h * 60 + m) : 0;
  res.json({ ok: true, active, minLeft });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.send('MaminHleb bot is running ✓'));

// ─── Установка вебхука ────────────────────────────────────────────────────────
async function setWebhook() {
  const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.WEBHOOK_BASE_URL;

  if (!RAILWAY_URL) {
    console.log('WEBHOOK_BASE_URL not set, skipping webhook setup');
    return;
  }

  const webhookPayload = {
    url:                  `${RAILWAY_URL}/webhook`,
    drop_pending_updates: false,
    max_connections:      40
  };
  if (WEBHOOK_SECRET) webhookPayload.secret_token = WEBHOOK_SECRET;
  const res = await tg('setWebhook', webhookPayload);
  console.log('setWebhook:', JSON.stringify(res));
}

function mskDateKey() {
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  return `${msk.getUTCFullYear()}-${String(msk.getUTCMonth()+1).padStart(2,'0')}-${String(msk.getUTCDate()).padStart(2,'0')}`;
}

// ─── Check-in в 06:00 Минск каждый день ──────────────────────────────────────
setInterval(() => {
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  const h   = msk.getUTCHours();
  const dateKey = mskDateKey();
  if (h >= 6 && h < 9 && getProp('checkin_sent_date') !== dateKey) {
    setProp('checkin_sent_date', dateKey);
    sendAdminCheckin().catch(e => console.error('checkin err:', e));
  }
}, 60000);

// ─── Happy Hour уведомления ───────────────────────────────────────────────────
async function sendHappyHourNotifications() {
  let clients = [];
  try { clients = JSON.parse(getProp('known_clients') || '[]'); } catch(e) {}
  if (!clients.length) { console.log('happyHour: no clients'); return; }
  console.log(`happyHour: sending to ${clients.length} clients`);
  const text =
    `🌆 *Добрый вечер!*\n\n` +
    `Настало время счастливого часа — скидка *30%* на всю оставшуюся продукцию для самовывоза.\n\n` +
    `Успейте забрать! 🥐`;
  const BATCH = 25;
  for (let i = 0; i < clients.length; i += BATCH) {
    await Promise.all(
      clients.slice(i, i + BATCH).map(cid =>
        tg('sendMessage', { chat_id: String(cid), text, parse_mode: 'Markdown' })
          .catch(e => console.error(`happyHour ${cid}:`, e.message))
      )
    );
    if (i + BATCH < clients.length) await new Promise(r => setTimeout(r, 1100));
  }
}

setInterval(() => {
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  const day = msk.getUTCDay();
  const h   = msk.getUTCHours();
  const dateKey   = mskDateKey();
  const isWeekday = day >= 1 && day <= 5;
  const isWeekend = day === 0 || day === 6;
  if (((isWeekday && h === 19) || (isWeekend && h === 17)) && getProp('happy_hour_sent_date') !== dateKey) {
    setProp('happy_hour_sent_date', dateKey);
    sendHappyHourNotifications().catch(e => console.error('happyHour err:', e));
  }
}, 60000);

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Bot listening on port ${PORT}`);
  await initDB();
  await syncCatalogToWarehouse();
  await setWebhook();
});
