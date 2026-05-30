'use strict';
require('dotenv').config();

const express   = require('express');
const fetch     = require('node-fetch');
const path      = require('path');
const crypto    = require('crypto');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool }  = require('pg');

const BOT_TOKEN        = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN        || '').trim();
const ADMIN_ID         = (process.env.ADMIN_ID         || '').trim();
const DELIVERY_CHAT_ID = (process.env.DELIVERY_CHAT_ID || '').trim();
const PREORDER_CHAT_ID = (process.env.PREORDER_CHAT_ID || '').trim();
const WEBHOOK_SECRET   = (process.env.WEBHOOK_SECRET   || '').trim();
const PORT             = process.env.PORT || 3000;

// ─── Allowed origins ──────────────────────────────────────────────────────────
// Telegram WebApp шлёт запросы с https://web.telegram.org и поддоменов.
// ALLOWED_ORIGINS — переменная среды, список через запятую.
const ALLOWED_ORIGINS_RAW = (process.env.ALLOWED_ORIGINS || '').trim();
const ALLOWED_ORIGINS = ALLOWED_ORIGINS_RAW
  ? ALLOWED_ORIGINS_RAW.split(',').map(s => s.trim()).filter(Boolean)
  : [];

const app = express();

// ─── Security headers (helmet) ────────────────────────────────────────────────
app.use(helmet({
  // Mini App рендерится внутри iframe Telegram — разрешаем от telegram.org
  frameguard: false,
  contentSecurityPolicy: false, // CSP добавим отдельно через мета-тег в HTML
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/fonts',  express.static(path.join(__dirname, 'public/fonts')));

// ─── CORS — только разрешённые origins ───────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const isTelegram = origin.endsWith('.telegram.org') || origin === 'https://telegram.org';
  const isAllowed  = ALLOWED_ORIGINS.includes(origin);
  if (isTelegram || isAllowed || !origin) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Telegram initData HMAC-верификация ───────────────────────────────────────
// Возвращает: 'ok' | 'invalid' | 'absent'
function checkTelegramInitData(initData) {
  if (!initData) return 'absent';
  if (!BOT_TOKEN) return 'ok'; // dev-режим без токена
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return 'invalid';
    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();
    const computed = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(hash,     'hex'),
      Buffer.from(computed, 'hex')
    ) ? 'ok' : 'invalid';
  } catch(e) {
    console.error('checkTelegramInitData error:', e.message);
    return 'invalid';
  }
}

// ─── Состояние (память + PostgreSQL) ─────────────────────────────────────────
const store  = new Map();
const cbSeen = new Set();

const pgSsl = process.env.DATABASE_URL
  ? (process.env.DATABASE_SSL === 'verify' ? true : { rejectUnauthorized: false })
  : false;
const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgSsl, max: 5, idleTimeoutMillis: 30000 })
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

async function saveOrderToDB(body, isPreorder, total, orderNum) {
  if (!pgPool) return;
  try {
    const items = typeof body.items === 'string' ? body.items : JSON.stringify(body.items || []);
    console.log('saveOrderToDB → Order', { orderNum, total, isPreorder });
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
        body.address || 'Самовывоз',
        isPreorder,
        String(body.telegramId || '0')
      ]
    );
    console.log('saveOrderToDB ✓ saved to Order');
  } catch(e) {
    console.error('saveOrderToDB FAILED:', e.message);
    console.error('  code:', e.code, '| detail:', e.detail);
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

// ─── Telegram API ─────────────────────────────────────────────────────────────
const TG_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const TG_TIMEOUT_MS = 15_000; // 15 секунд — стандарт для Telegram API

async function tg(method, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(`${TG_BASE}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
    return res.json();
  } catch(e) {
    const label = e.name === 'AbortError' ? `timeout(${TG_TIMEOUT_MS}ms)` : e.message;
    console.error(`tg(${method}): ${label}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function tgAll(calls) {
  return Promise.all(calls.map(([method, payload]) => tg(method, payload)));
}

// ─── Дедупликация заказов ─────────────────────────────────────────────────────
function isDuplicateOrder(body) {
  const raw = String(body.items || '').replace(/\s+/g, '').slice(0, 80);
  const key = `dup_${body.phone}_${String(body.total)}_${raw}`;
  const now = Date.now();
  const last = parseInt(getProp(key) || '0');
  if (last && now - last < 20000) return true;
  setProp(key, String(now));
  return false;
}

// ─── Вспомогательная: разбор строки "YYYY-MM-DD в HH:MM" ─────────────────────
function parsePreorderTime(timeStr) {
  if (!timeStr) return { niceDate: '—', time: '—' };
  const m = /^(\d{4}-\d{2}-\d{2}) в (\d{2}:\d{2})$/.exec(timeStr.trim());
  if (!m) return { niceDate: timeStr.trim(), time: '—' };
  const [, rawDate, rawTime] = m;
  const [y, mo, d] = rawDate.split('-');
  return { niceDate: `${d}.${mo}.${y}`, time: rawTime };
}

// ─── Обработка заказа ─────────────────────────────────────────────────────────
async function handleOrder(body) {
  if (isDuplicateOrder(body)) { console.log('Duplicate order ignored'); return; }
  const isPreorder = body.type === 'Предзаказ';
  const clientId   = String(body.telegramId || '0');
  const clientName = body.name || 'Гость';

  const catalogPriceMap = Object.fromEntries(CATALOG.map(p => [p.name.toLowerCase(), p.price]));

  let itemsText = '';
  let total = 0;
  try {
    const parsed = typeof body.items === 'string' ? JSON.parse(body.items) : body.items;
    if (Array.isArray(parsed)) {
      const lines = [];
      for (const i of parsed) {
        const name = String(i.product_name || i.name || '').trim();
        const qty  = Math.floor(Number(i.quantity));
        if (!name || !Number.isFinite(qty) || qty <= 0) continue;
        const serverPrice = catalogPriceMap[name.toLowerCase()];
        if (serverPrice === undefined) {
          console.warn(`handleOrder: unknown product "${name}" — rejected (not in CATALOG)`);
          continue;
        }
        total += serverPrice * qty;
        lines.push(`◆ ${name} x${qty} — ${(serverPrice * qty).toFixed(2)} Br`);
      }
      itemsText = lines.join('\n');
    } else {
      itemsText = String(body.items || '');
    }
  } catch(e) {
    itemsText = String(body.items || '');
  }

  const totalStr = total > 0 ? `${total.toFixed(2)} Br` : '0.00 Br';

  let deliveryBlock = '';
  if (isPreorder && body.time && body.time !== 'undefined') {
    const { niceDate, time: rawTime } = parsePreorderTime(body.time);
    deliveryBlock = `*ПРЕДЗАКАЗ:*\n📅 Дата: ${niceDate}\n🕐 Время: ${rawTime}`;
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

  saveOrderToDB(body, isPreorder, total > 0 ? total : Number(body.total || 0), orderNum);

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
    const { niceDate, time: rawTime } = parsePreorderTime(body.time || '');
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

// ─── Обработка кнопок ─────────────────────────────────────────────────────────
async function handleCallback(cb) {
  if (cbSeen.has(cb.id)) {
    await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '', show_alert: false });
    return;
  }
  cbSeen.add(cb.id);
  if (cbSeen.size > 10000) Array.from(cbSeen).slice(0, 1000).forEach(id => cbSeen.delete(id));

  const parts  = cb.data.split('_');
  const action = parts[0];

  if (action !== 'rate') {
    await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '', show_alert: false });
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

    const acceptText = `Здравствуйте 👋, ваш заказ "№${orderNum}" принят, мы уже его готовим`;
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

    if (orderType === 'delivery') {
      await editAdminMsg(adminChatId, adminMsgId, adminBase, 'Готов ✅', [[
        { text: '🚚 Отправить в доставку', callback_data: `dispatch_${rowNum}_${clientId}` }
      ]], adminBody);
      const r = await notifyClient(clientId, `Ваш заказ №${orderNum} готов, готовим его к отправке`);
      if (r?.ok) setProp(`ready_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    } else {
      await editAdminMsg(adminChatId, adminMsgId, adminBase, 'Готов ✅', [[
        { text: '✅ Выдан', callback_data: `done_${rowNum}_${clientId}` }
      ]], adminBody);
      const r = await notifyClient(clientId, `Ваш заказ №${orderNum} готов, ждём вас по адресу 📍 ул. Ленина 74`);
      if (r?.ok) setProp(`ready_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    }
    return;
  }

  // ── 3b. Отправить в доставку ──────────────────────────────────────────────
  if (action === 'dispatch') {
    if (orderType !== 'delivery') return;
    await deleteStoredMsg(`ready_msg_${rowNum}`);
    await editAdminMsg(adminChatId, adminMsgId, adminBase, '🚚 Передаётся курьеру', [[
      { text: '🚗 Передать курьеру', callback_data: `courier_${rowNum}_${clientId}` }
    ]], adminBody);
    const r = await notifyClient(clientId, `🚚 Заказ №${orderNum} готов! Передаём курьеру — скоро будет у вас`);
    if (r?.ok) setProp(`dispatch_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    return;
  }

  // ── 4a. Передан курьеру (только доставка) ────────────────────────────────
  if (action === 'courier') {
    if (orderType !== 'delivery') return;
    await deleteStoredMsg(`dispatch_msg_${rowNum}`);

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
      `🚗 Заказ №${orderNum} отправлен! Ориентировочное время: 30–45 мин. Курьер свяжется с вами!`);
    return;
  }

  // ── 4b. Выдан (самовывоз) / Доставлен (доставка) ─────────────────────────
  if (action === 'done') {
    await deleteStoredMsg(`ready_msg_${rowNum}`);

    if (orderType === 'delivery') {
      const deliveryMsgRaw = getProp(`delivery_msg_${rowNum}`);
      if (deliveryMsgRaw) {
        const dm = JSON.parse(deliveryMsgRaw);
        await tg('editMessageReplyMarkup', { chat_id: dm.chatId, message_id: dm.msgId, reply_markup: { inline_keyboard: [] } });
        delProp(`delivery_msg_${rowNum}`);
      }
      const adminMsgRaw = getProp(`admin_msg_${rowNum}`);
      const storedAdmin = adminMsgRaw ? JSON.parse(adminMsgRaw) : null;
      await editAdminMsg(
        storedAdmin ? storedAdmin.chatId : adminChatId,
        storedAdmin ? storedAdmin.msgId  : adminMsgId,
        adminBase, '✅ Доставлен', [], adminBody);
    } else {
      await editAdminMsg(adminChatId, adminMsgId, adminBase, '✅ Выдан', [], adminBody);
    }

    const r = await notifyClient(clientId,
      `🎉 Ваш заказ №${orderNum} уже у вас! Спасибо, что выбрали нас! 🙏\n\n⭐ *Оцените качество обслуживания:*`,
      ratingKeyboard(rowNum));
    if (r?.ok) setProp(`done_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
    return;
  }

  // ── 5. Отклонить / Отменить ───────────────────────────────────────────────
  if (action === 'decline' || action === 'cancel') {
    const label = action === 'cancel' ? 'Отменён' : 'Отклонён';
    const clientText = `❌ Ваш заказ №${orderNum} отклонён. Приносим извинения. Оформите свой заказ по новой`;

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
      `🔄 Ваш заказ №${orderNum} снова в обработке. Скоро свяжемся с вами!`);
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
    text:       isSkip ? '🌿 *Спасибо за оценку!* Рады видеть вас снова 🐿' : '🌿 *Спасибо за отзыв!*',
    parse_mode: 'Markdown'
  }]);

  await tgAll(calls);
  delProp(`pending_${senderId}`);
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 минута
  max: 10,                  // ≤ 10 заказов с одного IP за минуту
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

// ─── Маршруты ─────────────────────────────────────────────────────────────────

app.post('/webhook', (req, res) => {
  if (!WEBHOOK_SECRET) {
    console.warn('[webhook] WEBHOOK_SECRET не задан — webhook открыт для любых запросов');
  } else {
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

app.post('/order', orderLimiter, (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {
      console.error('/order JSON parse failed:', e.message);
      return res.status(400).json({ ok: false, error: 'bad_json' });
    }
  }
  if (!body || (!body.phone && !body.items)) {
    console.log('/order skipped — no phone/items');
    return res.json({ ok: false });
  }

  const initStatus = checkTelegramInitData(body.tgInitData || '');
  if (initStatus === 'invalid') {
    console.warn('/order: HMAC verification failed — rejected');
    return res.status(403).json({ ok: false, error: 'unauthorized' });
  }
  if (initStatus === 'absent') {
    console.warn('/order: tgInitData absent — soft-allow (log only)');
  }

  res.json({ ok: true });
  console.log('/order processing, type:', body.type);
  handleOrder(body).catch(e => console.error('order err:', e));
});


app.get('/api/stock', async (req, res) => {
  if (!pgPool) {
    return res.json({ ok: true, stock: {}, catalog: [], flags: {} });
  }
  try {
    const { rows } = await pgPool.query('SELECT name, stock, price FROM "Product"');
    const stock = {};
    rows.forEach(r => { stock[r.name.trim().toLowerCase()] = r.stock; });
    res.json({ ok: true, stock, catalog: [], flags: {} });
  } catch(e) {
    console.error('/api/stock DB error:', e.message);
    res.json({ ok: false });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', async (req, res) => {
  const checks = { uptime: Math.floor(process.uptime()) + 's', db: 'skip', tg: !!BOT_TOKEN };
  if (pgPool) {
    try {
      await pgPool.query('SELECT 1');
      checks.db = 'ok';
    } catch(e) {
      checks.db = 'error';
    }
  }
  const allOk = checks.db !== 'error';
  res.status(allOk ? 200 : 503).json({ ok: allOk, ...checks });
});

// ─── Установка вебхука ────────────────────────────────────────────────────────
async function setWebhook() {
  const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.WEBHOOK_BASE_URL;

  if (!RAILWAY_URL) {
    console.log('WEBHOOK_BASE_URL not set, skipping webhook setup');
    return;
  }

  const res = await tg('setWebhook', {
    url:                  `${RAILWAY_URL}/webhook`,
    drop_pending_updates: false,
    max_connections:      40
  });
  console.log('setWebhook:', JSON.stringify(res));
}

function mskDateKey() {
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  return `${msk.getUTCFullYear()}-${String(msk.getUTCMonth()+1).padStart(2,'0')}-${String(msk.getUTCDate()).padStart(2,'0')}`;
}

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
  const blocked = new Set();
  const BATCH = 25;
  for (let i = 0; i < clients.length; i += BATCH) {
    await Promise.all(
      clients.slice(i, i + BATCH).map(cid =>
        tg('sendMessage', { chat_id: String(cid), text, parse_mode: 'Markdown' })
          .then(r => { if (r && r.ok === false && (r.error_code === 403 || r.error_code === 400)) blocked.add(String(cid)); })
          .catch(e => console.error(`happyHour ${cid}:`, e.message))
      )
    );
    if (i + BATCH < clients.length) await new Promise(r => setTimeout(r, 1100));
  }
  // Удаляем клиентов, заблокировавших бота, чтобы список не рос бесконечно
  if (blocked.size) {
    const remaining = clients.filter(cid => !blocked.has(String(cid)));
    setProp('known_clients', JSON.stringify(remaining));
    console.log(`happyHour: removed ${blocked.size} blocked clients (${remaining.length} remain)`);
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
