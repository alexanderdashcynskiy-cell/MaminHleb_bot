'use strict';
require('dotenv').config();

const express   = require('express');
const fetch     = require('node-fetch');
const path      = require('path');
const { Pool }  = require('pg');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const { config, validateConfig } = require('./config');

const app = express();
app.set('trust proxy', 1); // Railway reverse proxy adds X-Forwarded-For
app.use(helmet({
  contentSecurityPolicy:    false, // задаём через мета-тег в HTML
  frameguard:               false, // Mini App встраивается в Telegram WebView
  crossOriginEmbedderPolicy: false, // нужно для Telegram WebApp embedding
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/fonts',  express.static(path.join(__dirname, 'public/fonts')));

const ALLOWED_ORIGINS = config.ALLOWED_ORIGINS;

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  // Разрешаем любой поддомен telegram.org (web.telegram.org, k.telegram.org и др.)
  const isTelegram = origin.endsWith('.telegram.org') || origin === 'https://telegram.org';
  const allowed = ALLOWED_ORIGINS.length
    ? ALLOWED_ORIGINS.includes(origin)
    : isTelegram || !origin;
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

const { BOT_TOKEN, ADMIN_ID, DELIVERY_CHAT_ID, WEBHOOK_SECRET, PORT } = config;

// ─── Состояние (память + PostgreSQL) ─────────────────────────────────────────
const cbSeen = new Map(); // id → timestamp; pruned hourly
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  cbSeen.forEach((ts, id) => { if (ts < cutoff) cbSeen.delete(id); });
}, 60 * 60 * 1000);

const pgSsl = config.DATABASE_URL
  ? (config.DATABASE_SSL === 'verify' ? true : { rejectUnauthorized: false })
  : false;
const pgPool = config.DATABASE_URL
  ? new Pool({ connectionString: config.DATABASE_URL, ssl: pgSsl, max: 5, idleTimeoutMillis: 30000 })
  : null;

// Bot Арх #3: storage adapter — pluggable key-value store; swap backend by replacing this object
const storageAdapter = (() => {
  const _store = new Map();
  return {
    get(key)        { return _store.get(key) || null; },
    size()          { return _store.size; },
    set(key, value) {
      _store.set(key, value);
      if (pgPool) {
        pgPool.query(
          'INSERT INTO bot_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [key, String(value)]
        ).catch(e => console.error('[storage] set failed:', e.message));
      }
    },
    del(key) {
      _store.delete(key);
      if (pgPool) {
        pgPool.query('DELETE FROM bot_state WHERE key = $1', [key])
          .catch(e => console.error('[storage] del failed:', e.message));
      }
    },
    async init() {
      if (!pgPool) {
        console.warn('[storage] PostgreSQL not configured — state in memory only (lost on restart)');
        return;
      }
      try {
        await pgPool.query(`
          CREATE TABLE IF NOT EXISTS bot_state (
            key   VARCHAR(512) PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
      } catch(e) { console.error('[storage] CREATE bot_state:', e.message); }
      try {
        const res = await pgPool.query('SELECT key, value FROM bot_state');
        res.rows.forEach(row => _store.set(row.key, row.value));
        console.log(`[storage] loaded ${_store.size} keys from PostgreSQL`);
      } catch(e) { console.error('[storage] load:', e.message); }
    }
  };
})();

async function initDB() {
  await storageAdapter.init();
  if (!pgPool) return;
  // Логируем все таблицы и колонки (отладка)
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

// Bot Арх #5: shared catalog schema with frontend — server is the canonical source
const CATALOG = [
  { name: 'Круассан Французский',    price: 3.50,  category: 'Выпечка',  emoji: '🥐', desc: 'Классический французский круассан с хрустящей слоёной корочкой' },
  { name: 'Пончик Глазированный',    price: 2.20,  category: 'Выпечка',  emoji: '🍩', desc: 'Воздушный пончик с сахарной глазурью' },
  { name: 'Макарон Малина',          price: 4.50,  category: 'Выпечка',  emoji: '🎨', desc: 'Нежный французский макарон с малиновой начинкой' },
  { name: 'Багет Французский',       price: 2.95,  category: 'Хлеб',     emoji: '🥖', desc: 'Традиционный французский багет с хрустящей корочкой' },
  { name: 'Хлеб Чёрный',            price: 2.10,  category: 'Хлеб',     emoji: '🍞', desc: 'Ароматный ржаной хлеб на закваске' },
  { name: 'Хлеб Пшеничный',         price: 1.80,  category: 'Хлеб',     emoji: '🍞', desc: 'Мягкий пшеничный хлеб для всей семьи' },
  { name: 'Хлеб Цельнозерновой',    price: 3.20,  category: 'Хлеб',     emoji: '🌾', desc: 'Полезный цельнозерновой хлеб с семенами' },
  { name: 'Пирог с Ягодами',        price: 9.50,  category: 'Пироги',   emoji: '🫐', desc: 'Сочный пирог с микс ягодной начинкой' },
  { name: 'Пирог с Курицей',        price: 19.20, category: 'Пироги',   emoji: '🥧', desc: 'Сытный закрытый пирог с курицей и грибами' },
  { name: 'Пирог Яблочный',         price: 8.30,  category: 'Пироги',   emoji: '🍎', desc: 'Классический яблочный пирог с корицей' },
  { name: 'Пирог Рыбный',           price: 16.50, category: 'Пироги',   emoji: '🐟', desc: 'Традиционный рыбный пирог с сёмгой' },
  { name: 'Торт Орео',              price: 73.00, category: 'Торты',    emoji: '🎂', desc: 'Шоколадный торт с кремом из печенья Орео' },
  { name: 'Торт Молочный',          price: 35.00, category: 'Торты',    emoji: '🍰', desc: 'Нежный молочный торт с ванильным кремом' },
  { name: 'Торт Шоколадный',        price: 52.00, category: 'Торты',    emoji: '🍫', desc: 'Насыщенный шоколадный торт с ганашем' },
  { name: 'Торт Ягодный',           price: 58.00, category: 'Торты',    emoji: '🍓', desc: 'Лёгкий бисквитный торт с ягодами и кремом' },
  { name: 'Перепечи с Сыром',       price: 2.50,  category: 'Снеки',    emoji: '🧀', desc: 'Удмуртские открытые пирожки с сырной начинкой' },
  { name: 'Сосиска в Тесте',        price: 1.85,  category: 'Снеки',    emoji: '🌭', desc: 'Сочная сосиска в мягком тесте' },
  { name: 'Хачапури',               price: 2.10,  category: 'Снеки',    emoji: '🫓', desc: 'Грузинская лепёшка с сыром' },
  { name: 'Пирожок с Мясом',        price: 1.75,  category: 'Снеки',    emoji: '🥟', desc: 'Сочный пирожок с мясной начинкой' },
  { name: 'Эчпочмак',               price: 2.10,  category: 'Снеки',    emoji: '🥟', desc: 'Татарский треугольный пирожок с мясом и картофелем' },
  { name: 'Слойка с Грибами',       price: 3.20,  category: 'Снеки',    emoji: '🍄', desc: 'Хрустящая слойка с грибной начинкой' },
  { name: 'Пицца Ветчина',          price: 3.90,  category: 'Пиццы',    emoji: '🍕', desc: 'Классическая пицца с ветчиной и сыром' },
  { name: 'Кальцоне',               price: 2.90,  category: 'Пиццы',    emoji: '🫓', desc: 'Закрытая пицца с начинкой из сыра и ветчины' },
  { name: 'Пицца Пепперони',        price: 4.20,  category: 'Пиццы',    emoji: '🍕', desc: 'Острая пицца с пепперони и моцареллой' },
  { name: 'Пицца Овощная',          price: 3.50,  category: 'Пиццы',    emoji: '🥦', desc: 'Лёгкая пицца с сезонными овощами' },
  { name: 'Капучино',               price: 3.00,  category: 'Напитки',  emoji: '☕', desc: 'Классический капучино с нежной молочной пенкой' },
  { name: 'Латте',                  price: 3.20,  category: 'Напитки',  emoji: '🥛', desc: 'Мягкий кофе латте с бархатистым молоком' },
  { name: 'Американо',              price: 2.50,  category: 'Напитки',  emoji: '☕', desc: 'Классический американо — насыщенный и ароматный' },
  { name: 'Макиято',                price: 3.30,  category: 'Напитки',  emoji: '☕', desc: 'Эспрессо с небольшим количеством вспененного молока' },
  { name: 'Кейк-попсы',            price: 4.50,  category: 'Десерты',  emoji: '🍭', desc: 'Шоколадные кейк-попсы на палочке' },
  { name: 'Эклер шоколадный',      price: 3.50,  category: 'Десерты',  emoji: '🍫', desc: 'Классический эклер с шоколадным кремом' },
  { name: 'Творожное кольцо',      price: 2.80,  category: 'Десерты',  emoji: '🍩', desc: 'Нежное творожное кольцо с сахарной пудрой' },
  { name: 'Медовик',               price: 3.90,  category: 'Десерты',  emoji: '🍯', desc: 'Традиционный медовый торт с нежным кремом' },
  { name: 'Молочный десерт',       price: 3.20,  category: 'Десерты',  emoji: '🍮', desc: 'Нежный молочный десерт с карамелью' },
  { name: 'Красный Бархат',        price: 4.80,  category: 'Десерты',  emoji: '❤️', desc: 'Классический красный бархат с сырным кремом' },
  { name: 'Капкейк Клубника',      price: 3.50,  category: 'Десерты',  emoji: '🍓', desc: 'Воздушный капкейк с клубничным кремом' },
  { name: 'Эклер клубничный',      price: 3.50,  category: 'Десерты',  emoji: '🍓', desc: 'Нежный эклер с клубничной начинкой' },
  { name: 'Тарт лимонный',         price: 4.20,  category: 'Десерты',  emoji: '🍋', desc: 'Французский тарт с лимонным курдом' },
  { name: 'Тарт карамель с орехами',price: 4.50, category: 'Десерты',  emoji: '🥜', desc: 'Тарт с карамелью и хрустящими орехами' },
  { name: 'Тарт малина-фисташка',  price: 4.80,  category: 'Десерты',  emoji: '🍃', desc: 'Изысканный тарт с малиной и фисташковым кремом' },
  { name: 'Трубочки со сгущёнкой', price: 2.50,  category: 'Десерты',  emoji: '🥮', desc: 'Хрустящие трубочки с нежной начинкой из сгущёнки' },
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
async function saveOrderToDB(body, isPreorder, total, orderNum, clientId, itemsText) {
  if (!pgPool) return true; // БД не настроена (dev): не блокируем заказ, считаем «нечего терять»
  try {
    const content = itemsText || (typeof body.items === 'string' ? body.items : JSON.stringify(body.items || []));
    console.log('saveOrderToDB → Order', { orderNum, total, isPreorder });
    await pgPool.query(
      `INSERT INTO "Order" ("orderNumber","customerName","phone","content","amount","status","address","isPreorder","telegramId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        String(orderNum),
        body.name    || 'Гость',
        body.phone   || null,
        content,
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

function getProp(key)        { return storageAdapter.get(key); }
function setProp(key, value) { storageAdapter.set(key, value); }
function delProp(key)        { storageAdapter.del(key); }

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

function isHappyHourNow() {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600_000);
  const day = msk.getUTCDay();
  const h   = msk.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const weekend = day === 0 || day === 6;
  return (weekday && h >= 19 && h < 20) || (weekend && h >= 17 && h < 18);
}

// ─── Обработка заказа ─────────────────────────────────────────────────────────
// Bot Арх #4: чистые помощники вынесены из handleOrder().
// handleOrder() теперь только оркестрирует БД/состояние/Telegram, а
// идентификация / ценообразование / формат доставки — отдельные функции без side-effects.

// BOT-M1: telegramId принимается только из верифицированного Telegram initData.
// Fallback на body.telegramId удалён — при провале верификации возвращаем '0'
// (анонимный заказ). Это предотвращает spoofing чужого Telegram ID.
function resolveClientId(body) {
  const rawInitData = body.tgInitData || body.initData;
  if (rawInitData && BOT_TOKEN) {
    const tgUser = verifyTgInitData(rawInitData, BOT_TOKEN);
    if (tgUser && tgUser.id) return String(tgUser.id);
    console.warn('resolveClientId: initData verification failed (hash mismatch or missing user)');
  }
  return '0';
}

// P0 #5: серверные цены из CATALOG; P3 #14: скидка happy hour на стороне сервера.
// Возвращает { itemsText, total, totalStr, hhActive } без побочных эффектов.
function priceOrder(body, isPreorder) {
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
        if (serverPrice === undefined) {
          console.warn(`priceOrder: unknown product "${name}" — rejected (not in CATALOG)`);
          return [];
        }
        const price = serverPrice;
        total += price * qty;
        return [`◆ ${name} x${qty} — ${(price * qty).toFixed(2)} Br`];
      }).join('\n');
    } else {
      itemsText = String(body.items || '');
    }
  } catch(e) {
    itemsText = String(body.items || '');
  }

  const hhActive = !isPreorder && isHappyHourNow();
  if (hhActive) total = Math.round(total * 0.7 * 100) / 100;
  const totalStr = (hhActive ? `~~${(total / 0.7).toFixed(2)}~~ ` : '') + total.toFixed(2) + ' Br' + (hhActive ? ' 🎉 -30% Счастливый час' : '');

  return { itemsText, total, totalStr, hhActive };
}

// Формат блока доставки/самовывоза/предзаказа. P2 #15: валидируем формат "YYYY-MM-DD в HH:MM".
function buildDeliveryBlock(body, isPreorder) {
  if (isPreorder && body.time && body.time !== 'undefined') {
    const pt = parsePreorderTime(body.time);
    return `*ПРЕДЗАКАЗ:*\n📅 Дата: ${pt.niceDate}\n🕐 Время: ${pt.rawTime}`;
  }
  if (body.address && body.address !== 'undefined' && body.address !== 'Самовывоз') {
    const payLabel = body.payment === 'card' ? '💳 Картой' : body.payment === 'cash' ? '💵 Наличными' : '';
    return `*АДРЕС ДОСТАВКИ:*\n🚕 ${body.address}${payLabel ? `\n${payLabel}` : ''}`;
  }
  if (body.time && body.time !== 'undefined') {
    return `*САМОВЫВОЗ:*\n📍 г. Витебск, ул. Ленина 74\n🕐 Время: ${body.time}`;
  }
  return `*САМОВЫВОЗ:*\n📍 г. Витебск, ул. Ленина 74`;
}

async function handleOrder(body) {
  if (isDuplicateOrder(body)) { console.log('Duplicate order ignored'); return { ok: true, duplicate: true }; }
  const isPreorder = body.type === 'Предзаказ';

  const clientId = resolveClientId(body);
  const { total } = priceOrder(body, isPreorder);
  const orderNum  = getNextOrderNum();

  const saved = await saveOrderToDB(body, isPreorder, total, orderNum, clientId);
  if (!saved) {
    console.error(`handleOrder: order #${orderNum} NOT persisted — aborting`);
    return { ok: false, error: 'save_failed' };
  }

  if (clientId !== '0') {
    // Сохраняем clientId для /api/order/done (рейтинг при выдаче заказа)
    setProp(`client_id_${orderNum}`, clientId);

    // Запомнить для happy hour уведомлений
    const clientsRaw = getProp('known_clients') || '[]';
    let clients = [];
    try { clients = JSON.parse(clientsRaw); } catch(e) {}
    if (!clients.includes(clientId)) {
      clients.push(clientId);
      setProp('known_clients', JSON.stringify(clients));
    }

    // Простое подтверждение клиенту; заказами управляет CRM-дашборд
    const r = await tg('sendMessage', {
      chat_id:    clientId,
      text:       `Здравствуйте 👋, ваш заказ №${orderNum} оформлен! Ожидайте подтверждения.`,
      parse_mode: 'Markdown'
    });
    if (r?.ok) setProp(`receipt_${orderNum}`, JSON.stringify({ chatId: clientId, msgId: r.result.message_id }));
  }

  return { ok: true, orderNum };
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
// ─── Обработка кнопок (checkin + оценка) ─────────────────────────────────────
// Управление заказами ведётся в CRM-дашборде, не через Telegram-кнопки.
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

  // ── Курьер подтверждает доставку ("✅ Доставлен" в чате доставки) ─────────
  if (action === 'delivered') {
    const dbId = parseInt(parts[1]);
    await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '✅ Статус обновлён', show_alert: false });
    // Убираем кнопку чтобы не нажимали повторно
    await tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });

    if (!pgPool || !dbId) return;
    try {
      const { rows } = await pgPool.query(
        `UPDATE "Order" SET status=$1 WHERE id=$2 RETURNING "orderNumber","telegramId"`,
        ['Доставлен', dbId]
      );
      if (!rows.length) { console.warn(`delivered: order id=${dbId} not found`); return; }
      const { orderNumber, telegramId } = rows[0];
      console.log(`delivered: order #${orderNumber} → Доставлен, clientId=${telegramId}`);
      if (telegramId && telegramId !== '0') {
        await tg('sendMessage', {
          chat_id:      String(telegramId),
          text:         `🎉 Ваш заказ №${orderNumber} доставлен!\n\nСпасибо, что выбрали нас! 🙏\n\nОцените качество обслуживания:`,
          reply_markup: { inline_keyboard: ratingKeyboard(orderNumber) }
        });
      }
    } catch(e) { console.error('delivered callback DB error:', e.message); }
    return;
  }

  // ── Оценка звёздами (rate_N_rowNum — от бота, star_N_orderNum — от CRM) ────
  if (action === 'rate' || action === 'star') {
    const stars    = parseInt(parts[1]);
    const refValue = parts[2]; // rowNum (rate) или orderNumber (star)
    const starStr  = '⭐'.repeat(stars) + ` (${stars}/5)`;

    await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: starStr, show_alert: false });

    const existingRaw = getProp(`pending_${cb.from.id}`);
    if (existingRaw) {
      try {
        const ep = JSON.parse(existingRaw);
        if (ep.reviewReqMsgId) {
          const update = action === 'star'
            ? { stars, orderNumber: refValue, reviewReqMsgId: ep.reviewReqMsgId }
            : { stars, rowNum: parseInt(refValue), reviewReqMsgId: ep.reviewReqMsgId };
          setProp(`pending_${cb.from.id}`, JSON.stringify(update));
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

    const pendingData = action === 'star'
      ? { stars, orderNumber: refValue, reviewReqMsgId: reviewRes?.ok ? reviewRes.result.message_id : null }
      : { stars, rowNum: parseInt(refValue), reviewReqMsgId: reviewRes?.ok ? reviewRes.result.message_id : null };
    setProp(`pending_${cb.from.id}`, JSON.stringify(pendingData));
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
      const orderNum = data.orderNumber || data.rowNum;
      await pgPool.query(
        `UPDATE "Order" SET review=$1, rating=$2 WHERE "orderNumber"=$3`,
        [msgText, data.stars || null, String(orderNum)]
      );
      console.log(`Review saved for order ${orderNum}`);
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

const VALID_ORDER_TYPES = new Set(['Заказ', 'Предзаказ', 'Доставка', 'Самовывоз', '']);
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


// Вызывается дашбордом когда заказ выдан/доставлен — отправляет клиенту запрос оценки
app.post('/api/order/done', async (req, res) => {
  const secret = config.ADMIN_SECRET;
  if (secret) {
    const provided = req.headers['x-admin-secret'] || (req.body || {}).adminSecret;
    if (provided !== secret) {
      console.warn('/api/order/done: 403 — неверный ADMIN_SECRET');
      return res.status(403).json({ ok: false, error: 'unauthorized' });
    }
  }

  const orderNum = String((req.body || {}).orderNumber || '');
  if (!orderNum) return res.status(400).json({ ok: false, error: 'orderNumber required' });

  // clientId ищем сначала в props, потом в БД (на случай рестарта сервера)
  let clientId = getProp(`client_id_${orderNum}`);
  if ((!clientId || clientId === '0') && pgPool) {
    try {
      const { rows } = await pgPool.query(
        `SELECT "telegramId" FROM "Order" WHERE "orderNumber" = $1 LIMIT 1`,
        [orderNum]
      );
      if (rows.length) clientId = rows[0].telegramId;
    } catch(e) {
      console.error('/api/order/done DB lookup:', e.message);
    }
  }

  res.json({ ok: true });

  if (!clientId || clientId === '0') {
    console.log(`/api/order/done: orderNumber=${orderNum} — clientId не найден, рейтинг пропущен`);
    return;
  }

  console.log(`/api/order/done: clientId=${clientId} orderNum=${orderNum}`);
  const ratingResult = await tg('sendMessage', {
    chat_id:      String(clientId),
    text:         `🎉 Ваш заказ №${orderNum} уже у вас!\n\nСпасибо, что выбрали нас! 🙏\n\nОцените качество обслуживания:`,
    reply_markup: { inline_keyboard: ratingKeyboard(orderNum) }
  });
  console.log(`/api/order/done: rating send →`, JSON.stringify(ratingResult).slice(0, 200));
  if (ratingResult?.ok) {
    setProp(`done_msg_${orderNum}`, JSON.stringify({ chatId: String(clientId), msgId: ratingResult.result.message_id }));
  }
});

// BOT-H1/DS-01: история доступна только по верифицированному initData.
// telegramId берётся из подписанного payload'а Telegram, не из query-параметра.
app.post('/api/orders/history', stockLimiter, async (req, res) => {
  const rawInitData = req.body?.tgInitData || '';
  if (!rawInitData) return res.json({ ok: true, orders: [] });

  const tgUser = verifyTgInitData(rawInitData, BOT_TOKEN);
  if (!tgUser || !tgUser.id) {
    return res.status(401).json({ ok: false, error: 'initData verification failed' });
  }

  const telegramId = String(tgUser.id);
  if (!pgPool) return res.json({ ok: true, orders: [], source: 'no_db' });
  try {
    const { rows } = await pgPool.query(
      `SELECT "orderNumber","customerName","phone","content","amount","status","address","isPreorder","telegramId","createdAt"
       FROM "Order"
       WHERE "telegramId" = $1
       ORDER BY "id" DESC
       LIMIT 10`,
      [telegramId]
    );
    res.json({ ok: true, orders: rows });
  } catch(e) {
    console.error('/api/orders/history error:', e.message);
    res.json({ ok: true, orders: [] });
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

// Bot Арх #5: canonical catalog endpoint — server is the single source of truth
app.get('/api/catalog', stockLimiter, (req, res) => {
  res.json({ ok: true, catalog: CATALOG });
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
app.post('/api/admin/checkin', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || '';
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await sendAdminCheckin();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    database: !!pgPool,
    telegram: !!BOT_TOKEN,
    ts: new Date().toISOString(),
  });
});

// ─── Установка вебхука ────────────────────────────────────────────────────────
async function setWebhook() {
  const RAILWAY_URL = config.WEBHOOK_BASE_URL;

  if (!RAILWAY_URL) {
    console.log('WEBHOOK_BASE_URL not set, skipping webhook setup');
    return;
  }

  const webhookPayload = {
    url:                  `${RAILWAY_URL}/webhook`,
    drop_pending_updates: false,
    max_connections:      40,
    allowed_updates:      ['message', 'edited_message', 'callback_query']
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
validateConfig();

app.listen(PORT, async () => {
  console.log(`Bot listening on port ${PORT}`);
  await initDB();
  await syncCatalogToWarehouse();
  await setWebhook();
});
