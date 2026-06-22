'use strict';
require('dotenv').config();

const express   = require('express');
const path      = require('path');
const { Pool }  = require('pg');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const { config, validateConfig } = require('./config');

// ─── Мониторинг ───────────────────────────────────────────────────────────────
let _botReqTotal = 0;
let _botReq5xx   = 0;
const _botReqTimesMs   = [];
const _botReqTimestamps = [];
let _botPeakRpm = 0;
const _botStartedAt = Date.now();

const BOT_ERR_LOG = [];
function pushBotErrLog(tag, msg) {
  BOT_ERR_LOG.push({ ts: Date.now(), tag, msg: String(msg).slice(0, 400) });
  if (BOT_ERR_LOG.length > 100) BOT_ERR_LOG.shift();
}

// Глобальный перехват console.error — все 35 мест ошибок автоматически
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
  _origConsoleError(...args);
  try {
    const first = args[0] != null ? String(args[0]) : '';
    const m = first.match(/^\[([^\]]+)\]\s*(.*)$/);
    const tag  = m ? m[1] : 'ERROR';
    const rest = m ? m[2] : first;
    const tail = args.slice(1).map(a => (a instanceof Error ? a.message : String(a))).join(' ');
    pushBotErrLog(tag, [rest, tail].filter(Boolean).join(' '));
  } catch {}
};

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[UNHANDLED]', msg);
});

const app = express();
// Railway always puts a trusted reverse proxy in front; trust proxy: 1 lets
// express-rate-limit key on real client IPs from X-Forwarded-For.
// Do NOT expose this service directly to the internet without a proxy — an
// attacker could forge X-Forwarded-For and bypass rate limiting.
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy:    false, // задаём через мета-тег в HTML
  frameguard:               false, // Mini App встраивается в Telegram WebView
  crossOriginEmbedderPolicy: false, // нужно для Telegram WebApp embedding
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.text({ type: 'text/plain', limit: '100kb' }));
app.use('/images',     express.static(path.join(__dirname, 'public/images')));
app.use('/fonts',      express.static(path.join(__dirname, 'public/fonts')));
// BOT-M2: статический CSS вместо Tailwind CDN
app.use('/styles.css', express.static(path.join(__dirname, 'public/styles.css')));

const ALLOWED_ORIGINS = config.ALLOWED_ORIGINS;

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  // Разрешаем любой поддомен telegram.org (web.telegram.org, k.telegram.org и др.)
  const isTelegram = origin.endsWith('.telegram.org') || origin === 'https://telegram.org';
  const allowed = ALLOWED_ORIGINS.length
    ? ALLOWED_ORIGINS.includes(origin)
    : isTelegram || !origin;
  if (allowed) {
    if (origin) res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods',  'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers',  'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Метрики запросов: счётчик, 5xx, скользящее окно 500 ответов (p50/p95/avg), RPM
app.use((req, res, next) => {
  const start = Date.now();
  _botReqTotal++;
  _botReqTimestamps.push(start);
  const cutoff = start - 60_000;
  let i = 0; while (i < _botReqTimestamps.length && _botReqTimestamps[i] < cutoff) i++;
  if (i > 0) _botReqTimestamps.splice(0, i);
  if (_botReqTimestamps.length > _botPeakRpm) _botPeakRpm = _botReqTimestamps.length;
  res.on('finish', () => {
    const ms = Date.now() - start;
    _botReqTimesMs.push(ms);
    if (_botReqTimesMs.length > 500) _botReqTimesMs.shift();
    if (res.statusCode >= 500) _botReq5xx++;
  });
  next();
});

const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 10,  standardHeaders: true, legacyHeaders: false });
const stockLimiter = rateLimit({ windowMs: 60 * 1000, max: 30,  standardHeaders: true, legacyHeaders: false });
const hhLimiter    = rateLimit({ windowMs: 60 * 1000, max: 60,  standardHeaders: true, legacyHeaders: false });

const { BOT_TOKEN, ADMIN_ID, DELIVERY_CHAT_ID, WEBHOOK_SECRET, PORT } = config;

// ─── Состояние (память + PostgreSQL) ─────────────────────────────────────────
const cbSeen = new Map(); // id → timestamp; pruned hourly
const CB_SEEN_MAX = 50_000;
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  cbSeen.forEach((ts, id) => { if (ts < cutoff) cbSeen.delete(id); });
  if (cbSeen.size > CB_SEEN_MAX) {
    // Keep only the most recent half on burst traffic
    const sorted = [...cbSeen.entries()].sort((a, b) => b[1] - a[1]);
    cbSeen.clear();
    sorted.slice(0, CB_SEEN_MAX / 2).forEach(([k, v]) => cbSeen.set(k, v));
  }
}, 60 * 60 * 1000);

const pgSsl = config.DATABASE_URL
  ? (config.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : true)
  : false;
if (config.DATABASE_URL && config.DATABASE_SSL === 'no-verify') {
  console.warn('[db] TLS certificate verification DISABLED (DATABASE_SSL=no-verify). Vulnerable to MITM on untrusted networks. Set DATABASE_SSL=verify for production with a trusted CA.');
}
// max: 20 — Railway Starter PostgreSQL допускает до 25 соединений;
// 5 исчерпывались уже при ~15 одновременных запросах к /api/stock
const pgPool = config.DATABASE_URL
  ? new Pool({ connectionString: config.DATABASE_URL, ssl: pgSsl, max: 20, idleTimeoutMillis: 120000, connectionTimeoutMillis: 5000, keepAlive: true })
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
          'INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
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
    // Эфемерные служебные ключи (дедуп заказов/сообщений, разовые receipt/done_msg)
    // только пишутся и больше не читаются — без очистки bot_state растёт бесконечно
    // (деградация БД + утечка памяти в _store). Чистим всё старше 7 дней.
    async prune() {
      if (!pgPool) return;
      try {
        const { rows } = await pgPool.query(
          `DELETE FROM bot_state
             WHERE updated_at < NOW() - INTERVAL '7 days'
               AND (key LIKE 'dup_%' OR key LIKE 'msg_%' OR key LIKE 'receipt_%' OR key LIKE 'done_msg_%')
           RETURNING key`
        );
        rows.forEach(r => _store.delete(r.key));
        if (rows.length) console.log(`[storage] pruned ${rows.length} stale ephemeral keys`);
      } catch(e) { console.error('[storage] prune failed:', e.message); }
    },
    async init() {
      if (!pgPool) {
        console.warn('[storage] PostgreSQL not configured — state in memory only (lost on restart)');
        return;
      }
      try {
        await pgPool.query(`
          CREATE TABLE IF NOT EXISTS bot_state (
            key        VARCHAR(512) PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pgPool.query(`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
      } catch(e) { console.error('[storage] CREATE bot_state:', e.message); }
      try {
        const res = await pgPool.query('SELECT key, value FROM bot_state');
        res.rows.forEach(row => _store.set(row.key, row.value));
        console.log(`[storage] loaded ${_store.size} keys from PostgreSQL`);
      } catch(e) { console.error('[storage] load:', e.message); }
    }
  };
})();

// Периодическая очистка устаревших эфемерных ключей bot_state (раз в 6 часов).
setInterval(() => { storageAdapter.prune(); }, 6 * 60 * 60 * 1000);

async function initDB() {
  await storageAdapter.init();
  storageAdapter.prune();
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS "Product" (
        id       SERIAL PRIMARY KEY,
        name     VARCHAR(256) NOT NULL UNIQUE,
        stock    INTEGER NOT NULL DEFAULT 0,
        price    NUMERIC(10,2) NOT NULL DEFAULT 0,
        category VARCHAR(64)
      )
    `);
  } catch(e) { console.error('CREATE Product:', e.message); }
  // Дамп схемы БД в логи убран: Railway-логи доступны через dashboard/API,
  // полный список таблиц и колонок — подарок атакующему
}

// BOT-M3: единый источник расписания «счастливого часа» и скидки.
// Используется и в isHappyHourNow(), и в /api/happyhour, и в /api/config —
// чтобы расписание не расходилось между бэкендом и Mini App.
const HAPPY_HOUR = {
  weekday: { start: 19, end: 20 }, // Пн–Пт
  weekend: { start: 17, end: 18 }, // Сб–Вс
  discount: 0.30,                  // 30% скидка
};

// Bot Арх #5: shared catalog schema with frontend — server is the canonical source
const CATALOG = [
  { name: 'Круассан Французский',    price: 3.50,  category: 'Пирожки',  emoji: '🥐', desc: 'Классический французский круассан с хрустящей слоёной корочкой' },
  { name: 'Пончик Глазированный',    price: 2.20,  category: 'Десерты',  emoji: '🍩', desc: 'Воздушный пончик с сахарной глазурью' },
  { name: 'Макарон Малина',          price: 4.50,  category: 'Десерты',  emoji: '🎨', desc: 'Нежный французский макарон с малиновой начинкой' },
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
  { name: 'Перепечи с Сыром',       price: 2.50,  category: 'Пирожки',    emoji: '🧀', desc: 'Удмуртские открытые пирожки с сырной начинкой' },
  { name: 'Сосиска в Тесте',        price: 1.85,  category: 'Пирожки',    emoji: '🌭', desc: 'Сочная сосиска в мягком тесте' },
  { name: 'Хачапури',               price: 2.10,  category: 'Пирожки',    emoji: '🫓', desc: 'Грузинская лепёшка с сыром' },
  { name: 'Пирожок с Мясом',        price: 1.75,  category: 'Пирожки',    emoji: '🥟', desc: 'Сочный пирожок с мясной начинкой' },
  { name: 'Эчпочмак',               price: 2.10,  category: 'Пирожки',    emoji: '🥟', desc: 'Татарский треугольный пирожок с мясом и картофелем' },
  { name: 'Слойка с Грибами',       price: 3.20,  category: 'Пирожки',    emoji: '🍄', desc: 'Хрустящая слойка с грибной начинкой' },
  { name: 'Пицца Ветчина',          price: 3.90,  category: 'Пицца',    emoji: '🍕', desc: 'Классическая пицца с ветчиной и сыром' },
  { name: 'Кальцоне',               price: 2.90,  category: 'Пицца',    emoji: '🫓', desc: 'Закрытая пицца с начинкой из сыра и ветчины' },
  { name: 'Пицца Пепперони',        price: 4.20,  category: 'Пицца',    emoji: '🍕', desc: 'Острая пицца с пепперони и моцареллой' },
  { name: 'Пицца Овощная',          price: 3.50,  category: 'Пицца',    emoji: '🥦', desc: 'Лёгкая пицца с сезонными овощами' },
  { name: 'Капучино',               price: 3.00,  category: 'Кофе',  emoji: '☕', desc: 'Классический капучино с нежной молочной пенкой' },
  { name: 'Латте',                  price: 3.20,  category: 'Кофе',  emoji: '🥛', desc: 'Мягкий кофе латте с бархатистым молоком' },
  { name: 'Американо',              price: 2.50,  category: 'Кофе',  emoji: '☕', desc: 'Классический американо — насыщенный и ароматный' },
  { name: 'Макиято',                price: 3.30,  category: 'Кофе',  emoji: '☕', desc: 'Эспрессо с небольшим количеством вспененного молока' },
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

// Категории, у которых нет складского учёта — всегда в наличии.
const UNTRACKED_CATEGORIES = new Set(['Кофе']);
const untrackedNames = new Set(
  CATALOG.filter(p => UNTRACKED_CATEGORIES.has(p.category)).map(p => p.name.toLowerCase())
);

async function syncCatalogToWarehouse() {
  if (!pgPool) return;
  try {
    // Колонки могут отсутствовать в схеме (таблицу могла создать CRM) — добавляем безопасно.
    await pgPool.query(`ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS category VARCHAR(64)`);
    await pgPool.query(`ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "isNew" BOOLEAN NOT NULL DEFAULT false`);
    await pgPool.query(`ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "isBestSeller" BOOLEAN NOT NULL DEFAULT false`);

    // Batch: раньше здесь было 2 запроса × 41 позиция = 82 round-trip при каждом
    // холодном старте (2-5 сек блокировки readiness). Теперь 2 запроса на весь каталог.
    const names      = CATALOG.map(p => p.name);
    const prices     = CATALOG.map(p => p.price);
    const categories = CATALOG.map(p => p.category);

    await pgPool.query(
      `INSERT INTO "Product" (name, stock, price, category)
       SELECT t.n, 0, t.p, t.c
       FROM unnest($1::text[], $2::float8[], $3::text[]) AS t(n, p, c)
       WHERE NOT EXISTS (SELECT 1 FROM "Product" pr WHERE pr.name = t.n)`,
      [names, prices, categories]
    );
    await pgPool.query(
      `UPDATE "Product" pr SET category = t.c
       FROM unnest($1::text[], $2::text[]) AS t(n, c)
       WHERE pr.name = t.n AND pr.category IS DISTINCT FROM t.c`,
      [names, categories]
    );
    console.log(`Product synced: ${CATALOG.length} items (с категориями)`);
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
    console.error('  code:', e.code);
    return false;
  }
}

function getProp(key)        { return storageAdapter.get(key); }
function setProp(key, value) { storageAdapter.set(key, value); }
function delProp(key)        { storageAdapter.del(key); }

// Счётчик заказов. С pgPool — атомарный INSERT … ON CONFLICT … RETURNING,
// корректный и при нескольких инстансах (каждый со своим in-memory кэшем).
// Без БД — синхронный fallback на кэш (гонок в одном event loop нет).
async function getNextOrderNum() {
  if (pgPool) {
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO bot_state (key, value, updated_at) VALUES ('order_counter', '1', NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = (COALESCE(NULLIF(bot_state.value, ''), '0')::bigint + 1)::text,
               updated_at = NOW()
         RETURNING value`
      );
      // НЕ вызываем setProp: повторная неатомарная запись вернула бы гонку.
      // order_counter читается только здесь, причём из БД, так что кэш не нужен.
      return parseInt(rows[0].value, 10);
    } catch (e) {
      console.error('getNextOrderNum DB error, fallback to cache:', e.message);
    }
  }
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

// BOT-M3: экранирование пользовательского текста для Telegram parse_mode:HTML.
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// BOT-L1: constant-time сравнение строк-секретов — предотвращает timing-атаку.
function safeEquals(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ─── Верификация Telegram initData ────────────────────────────────────────────
// BOT-M5: проверяем auth_date — initData не старше 1 часа.
// Без этого перехваченный или утёкший initData остаётся валидным бесконечно.
const INIT_DATA_MAX_AGE_SEC = 3600;

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
    const expected  = crypto.createHmac('sha256', secretKey).update(dataCheckStr).digest();
    const hashBuf   = Buffer.from(hash, 'hex');
    if (hashBuf.length !== expected.length || !crypto.timingSafeEqual(hashBuf, expected)) return null;
    // Проверка свежести: auth_date обязан присутствовать и быть не старее MAX_AGE.
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > INIT_DATA_MAX_AGE_SEC) return null;
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
  const isWeekend = day === 0 || day === 6;
  const win = isWeekend ? HAPPY_HOUR.weekend : HAPPY_HOUR.weekday;
  return h >= win.start && h < win.end;
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
      // DoS-защита: без лимита атакующий может прислать 100 000 позиций —
      // O(N) цикл здесь + O(N) SQL в decrementStock
      if (parsed.length > 50) throw new Error(`too many items: ${parsed.length}`);
      itemsText = parsed.flatMap(i => {
        const name = (i.product_name || '').trim();
        const qty  = Math.floor(Number(i.quantity));
        if (!name || !Number.isFinite(qty) || qty <= 0 || qty > 500) return [];
        const serverPrice = catalogPriceMap[name.toLowerCase()];
        if (serverPrice === undefined) {
          console.warn(`priceOrder: unknown product "${name.replace(/[\r\n\t]/g, ' ')}" — rejected (not in CATALOG)`);
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
  const hhFactor = 1 - HAPPY_HOUR.discount;
  if (hhActive) total = Math.round(total * hhFactor * 100) / 100;
  const hhPct = Math.round(HAPPY_HOUR.discount * 100);
  const totalStr = (hhActive ? `~~${(total / hhFactor).toFixed(2)}~~ ` : '') + total.toFixed(2) + ' Br' + (hhActive ? ` 🎉 -${hhPct}% Счастливый час` : '');

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

async function decrementStock(body) {
  if (!pgPool) return;
  try {
    const parsed = typeof body.items === 'string' ? JSON.parse(body.items) : body.items;
    if (!Array.isArray(parsed)) return;
    const names = [], qtys = [];
    for (const i of parsed) {
      const name = (i.product_name || '').trim();
      const qty  = Math.floor(Number(i.quantity));
      if (!name || !Number.isFinite(qty) || qty <= 0) continue;
      if (untrackedNames.has(name.toLowerCase())) continue;
      names.push(name);
      qtys.push(qty);
    }
    if (names.length === 0) return;
    // Один batch-UPDATE вместо N последовательных round-trip к PG
    await pgPool.query(
      `UPDATE "Product" pr SET stock = GREATEST(0, pr.stock - t.q)
       FROM unnest($1::text[], $2::int[]) AS t(n, q)
       WHERE pr.name = t.n`,
      [names, qtys]
    );
    console.log(`decrementStock: stock updated for ${names.length} items`);
    invalidateStockCache();
  } catch(e) {
    console.error('decrementStock:', e.message);
  }
}

async function handleOrder(body) {
  if (isDuplicateOrder(body)) { console.log('Duplicate order ignored'); return { ok: true, duplicate: true }; }
  const isPreorder = body.type === 'Предзаказ';

  const clientId = resolveClientId(body);
  const { total } = priceOrder(body, isPreorder);
  const orderNum  = await getNextOrderNum();

  const saved = await saveOrderToDB(body, isPreorder, total, orderNum, clientId);
  if (!saved) {
    console.error(`handleOrder: order #${orderNum} NOT persisted — aborting`);
    return { ok: false, error: 'save_failed' };
  }

  await decrementStock(body);

  if (clientId !== '0') {
    // Сохраняем clientId для /api/order/done (рейтинг при выдаче заказа)
    setProp(`client_id_${orderNum}`, clientId);

    // Запомнить для happy hour уведомлений.
    // Лимит MAX_KNOWN_CLIENTS: без него массив растёт бесконечно — каждый
    // getProp/setProp (де)сериализует сотни КБ JSON и блокирует event loop.
    const MAX_KNOWN_CLIENTS = 5000;
    const clientsRaw = getProp('known_clients') || '[]';
    let clients = [];
    try { clients = JSON.parse(clientsRaw); } catch(e) {}
    if (!Array.isArray(clients)) clients = [];
    if (!clients.includes(clientId) && /^\d{5,}$/.test(String(clientId))) {
      clients.push(clientId);
      if (clients.length > MAX_KNOWN_CLIENTS) clients = clients.slice(-MAX_KNOWN_CLIENTS);
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
    // Only accept from the configured delivery chat to prevent unauthorized status changes
    if (DELIVERY_CHAT_ID && String(cb.message?.chat?.id) !== String(DELIVERY_CHAT_ID)) {
      await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '', show_alert: false });
      return;
    }
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
      console.log(`delivered: order #${orderNumber} → Доставлен, clientId=…${String(telegramId).slice(-4)}`);
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
    const stars    = parseInt(parts[1], 10);
    // Диапазон 1–5 обязателен: иначе stars=999 запишется в БД и '⭐'.repeat(999)
    // построит огромную строку (порча данных / мелкий DoS).
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '', show_alert: false });
      return;
    }
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

  const msgKey = `msg_${message.chat.id}_${message.message_id}`;
  if (getProp(msgKey)) return;
  setProp(msgKey, '1');

  // ── Check-in администратора ───────────────────────────────────────────────
  const checkinRaw = senderId === ADMIN_ID ? getProp(`pending_checkin_${ADMIN_ID}`) : null;
  if (checkinRaw) {
    let cd = {};
    try { cd = JSON.parse(checkinRaw) || {}; } catch { cd = {}; }
    if (cd.promptMsgId) await tg('deleteMessage', { chat_id: senderId, message_id: cd.promptMsgId });
    await tg('sendMessage', {
      chat_id:    senderId,
      text:       `✅ Записано! Сегодня работает: <b>${escHtml(msgText)}</b>`,
      parse_mode: 'HTML'
    });
    delProp(`pending_checkin_${senderId}`);
    return;
  }

  // ── Отзыв после оценки ────────────────────────────────────────────────────
  const pendingRaw = getProp(`pending_${senderId}`);
  if (!pendingRaw) return;

  let data = {};
  try { data = JSON.parse(pendingRaw) || {}; } catch { delProp(`pending_${senderId}`); return; }
  const isSkip = msgText === '/skip';

  if (!isSkip && pgPool) {
    try {
      const orderNum = data.orderNumber || data.rowNum;
      await pgPool.query(
        `UPDATE "Order" SET review=$1, rating=$2 WHERE "orderNumber"=$3`,
        [msgText.slice(0, 2000), data.stars || null, String(orderNum)]
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
    console.error('[webhook] WEBHOOK_SECRET не задан — все запросы отклоняются. Задайте WEBHOOK_SECRET в .env');
    return res.sendStatus(403);
  }
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (!safeEquals(token, WEBHOOK_SECRET)) return res.sendStatus(403);
  res.sendStatus(200);
  const body = req.body;
  if (!body) return;
  if (body.callback_query) {
    handleCallback(body.callback_query).catch(e => console.error('callback err:', e?.message || String(e)));
  } else if (body.message?.text) {
    handleTextMessage(body.message).catch(e => console.error('message err:', e?.message || String(e)));
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

  const phone = String(body.phone || '').trim().slice(0, 30);
  const name  = String(body.name  || '').trim().slice(0, 100);
  const type  = String(body.type  || '').trim();
  body.address = String(body.address || '').trim().slice(0, 300);
  body.note    = String(body.note    || '').trim().slice(0, 500);

  if (!phone || !PHONE_RE.test(phone)) {
    console.warn('/order rejected: missing or invalid phone (****' + String(phone).slice(-4) + ')');
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
  if (type === 'Предзаказ') {
    // Full preorder datetime format: "YYYY-MM-DD в HH:MM"
    const fullTimeStr = String(body.time || '').trim();
    const fullM = fullTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+в\s+(\d{1,2}):(\d{2})$/);
    if (!fullM) return res.status(400).json({ ok: false, error: 'invalid_preorder_time_format' });
    const totalMin = parseInt(fullM[4], 10) * 60 + parseInt(fullM[5], 10);
    if (totalMin < 7 * 60 || totalMin > 11 * 60) {
      return res.status(400).json({ ok: false, error: 'preorder_time_out_of_range', message: 'Время предзаказа должно быть в диапазоне 07:00–11:00' });
    }
    const orderDate = new Date(`${fullM[1]}-${fullM[2]}-${fullM[3]}T00:00:00`);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const maxDate = new Date(today); maxDate.setDate(today.getDate() + 30);
    if (orderDate < today) {
      return res.status(400).json({ ok: false, error: 'preorder_date_in_past', message: 'Дата предзаказа не может быть в прошлом' });
    }
    if (orderDate > maxDate) {
      return res.status(400).json({ ok: false, error: 'preorder_date_too_far', message: 'Дата предзаказа не может быть позже чем через 30 дней' });
    }
  }

  // P2 #12 (сервер): дожидаемся подтверждения записи заказа и отдаём клиенту реальный
  // результат, чтобы фронт не очищал корзину и не показывал чек при сбое.
  console.log('/order accepted, type:', type, 'name:', (name ? name[0]+'***' : '?'), 'phone: ****'+String(phone).slice(-4));
  try {
    const result = await handleOrder(body);
    if (result && result.ok) {
      return res.json({ ok: true, orderNum: result.orderNum });
    }
    return res.status(502).json({ ok: false, error: (result && result.error) || 'order_failed' });
  } catch(e) {
    console.error('order err:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});


// Вызывается дашбордом когда заказ выдан/доставлен — отправляет клиенту запрос оценки
app.post('/api/order/done', async (req, res) => {
  const secret = config.ADMIN_SECRET;
  if (!secret) {
    console.error('[order/done] ADMIN_SECRET не задан — все запросы отклоняются. Задайте ADMIN_SECRET в .env');
    return res.status(403).json({ ok: false, error: 'unauthorized' });
  }
  const provided = req.headers['x-admin-secret'] || (req.body || {}).adminSecret;
  if (!safeEquals(provided, secret)) {
    console.warn('/api/order/done: 403 — неверный ADMIN_SECRET');
    return res.status(403).json({ ok: false, error: 'unauthorized' });
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

  console.log(`/api/order/done: clientId=…${String(clientId).slice(-4)} orderNum=${orderNum}`);
  const ratingResult = await tg('sendMessage', {
    chat_id:      String(clientId),
    text:         `🎉 Ваш заказ №${orderNum} уже у вас!\n\nСпасибо, что выбрали нас! 🙏\n\nОцените качество обслуживания:`,
    reply_markup: { inline_keyboard: ratingKeyboard(orderNum) }
  });
  console.log(`/api/order/done: rating send → ok=${ratingResult?.ok}`);
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

// BOT-M3: приём отзыва из Mini App. Текст экранируется и пересылается админу.
// telegramId считается недоверенным (клиент шлёт его напрямую, без initData),
// поэтому используется только как информационная метка, не как идентификатор.
app.post('/review', orderLimiter, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 100);
  const text = String(body.text || '').trim().slice(0, 2000);
  const items = String(body.items || '').trim().slice(0, 1000);
  const tgId = String(body.telegramId || '0').replace(/[^0-9]/g, '').slice(0, 20) || '0';
  const ratingRaw = parseInt(body.rating, 10);
  const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;

  if (!name || !text) {
    return res.status(400).json({ ok: false, error: 'name and text required' });
  }

  const starsStr = rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '—';
  const adminMsg =
    `📝 <b>Новый отзыв из Mini App</b>\n\n` +
    `👤 <b>Имя:</b> ${escHtml(name)}\n` +
    `⭐ <b>Оценка:</b> ${starsStr}\n` +
    `🆔 <b>Telegram ID:</b> ${escHtml(tgId)} <i>(не верифицирован)</i>\n` +
    (items ? `🛒 <b>Заказ:</b> ${escHtml(items)}\n` : '') +
    `\n💬 ${escHtml(text)}`;

  if (ADMIN_ID) {
    await tg('sendMessage', { chat_id: String(ADMIN_ID), text: adminMsg, parse_mode: 'HTML' });
  } else {
    console.warn('/review: ADMIN_ID не задан — отзыв не переслан');
  }

  if (pgPool && rating !== null) {
    try {
      await pgPool.query(
        `UPDATE "Order" SET rating=$1 WHERE id = (
           SELECT id FROM "Order" WHERE "telegramId"=$2 AND rating IS NULL
           ORDER BY "createdAt" DESC LIMIT 1
         )`,
        [rating, tgId]
      );
    } catch(e) { console.error('/review rating save:', e.message); }
  }

  res.json({ ok: true });
});

// Кэш /api/stock: каждое открытие Mini App дёргает этот endpoint, без кэша
// 50 одновременных пользователей = 50 SELECT и исчерпание пула соединений.
// TTL 30 с; при заказе кэш сбрасывается (см. decrementStock).
const _stockCache = { payload: null, ts: 0 };
const STOCK_CACHE_TTL = 30_000;
function invalidateStockCache() { _stockCache.payload = null; _stockCache.ts = 0; }

app.get('/api/stock', stockLimiter, async (req, res) => {
  if (!pgPool) {
    return res.json({ ok: false, error: 'db_unavailable', stock: {}, catalog: [], flags: {} });
  }
  if (_stockCache.payload && Date.now() - _stockCache.ts < STOCK_CACHE_TTL) {
    return res.json(_stockCache.payload);
  }
  try {
    const result = await pgPool.query('SELECT name, stock, "isNew", "isBestSeller" FROM "Product"');
    const stock = {};
    const flags = {};
    result.rows.forEach(r => {
      if (!untrackedNames.has(r.name.toLowerCase())) stock[r.name.toLowerCase()] = r.stock;
      if (r.isNew || r.isBestSeller) {
        flags[r.name.toLowerCase()] = { isNew: !!r.isNew, bestseller: !!r.isBestSeller };
      }
    });
    const payload = { ok: true, stock, catalog: CATALOG, flags };
    _stockCache.payload = payload;
    _stockCache.ts = Date.now();
    res.json(payload);
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
  const isWeekend = day === 0 || day === 6;
  const win     = isWeekend ? HAPPY_HOUR.weekend : HAPPY_HOUR.weekday;
  const active  = h >= win.start && h < win.end;
  const minLeft = active ? (win.end * 60) - (h * 60 + m) : 0;
  res.json({ ok: true, active, minLeft });
});

// BOT-M3: конфиг для Mini App (fetchConfig) — расписание happy hour и скидка.
// Single source of truth — const HAPPY_HOUR выше.
app.get('/api/config', hhLimiter, (req, res) => {
  res.json({
    ok: true,
    happyHour: {
      weekday:  HAPPY_HOUR.weekday,
      weekend:  HAPPY_HOUR.weekend,
      discount: HAPPY_HOUR.discount,
    },
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.post('/api/admin/checkin', async (req, res) => {
  // Используем выделенный ADMIN_SECRET (как /api/order/done), а не WEBHOOK_SECRET —
  // чтобы ротация/компрометация секрета Telegram-webhook не влияла на админ-действия.
  const secret = req.headers['x-admin-secret'] || '';
  const ADMIN_SECRET = config.ADMIN_SECRET;
  if (!ADMIN_SECRET || !safeEquals(secret, ADMIN_SECRET)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await sendAdminCheckin();
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/admin/checkin error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/health', async (req, res) => {
  const isAdmin = config.ADMIN_SECRET && safeEquals(req.headers['x-admin-secret'] || '', config.ADMIN_SECRET);
  if (!isAdmin) return res.json({ status: 'ok' });

  let database = false, dbLatencyMs = 0;
  if (pgPool) {
    try {
      const t = Date.now();
      await pgPool.query('SELECT 1');
      database = true;
      dbLatencyMs = Date.now() - t;
    } catch { database = false; }
  }

  // Метрики запросов + перцентили
  const sorted = [..._botReqTimesMs].sort((a, b) => a - b);
  const p50    = sorted[Math.floor(sorted.length * 0.5)]  ?? 0;
  const p95    = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const avgMs  = sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;

  // Разбивка ошибок по тегу
  const errByTag = {};
  BOT_ERR_LOG.forEach(e => { errByTag[e.tag] = (errByTag[e.tag] || 0) + 1; });

  // Заказы за сегодня (UTC+3 Минск)
  let ordersToday = 0;
  if (pgPool) {
    try {
      const MINSK_MS = 3 * 60 * 60 * 1000;
      const minskNow = new Date(Date.now() + MINSK_MS);
      minskNow.setUTCHours(0, 0, 0, 0);
      const todayStart = new Date(minskNow.getTime() - MINSK_MS);
      const { rows } = await pgPool.query(
        'SELECT COUNT(*) FROM "Order" WHERE "createdAt" >= $1', [todayStart]
      );
      ordersToday = parseInt(rows[0].count, 10) || 0;
    } catch {}
  }

  res.json({
    status:      'ok',
    startedAt:   _botStartedAt,
    uptime:      Math.floor(process.uptime()),
    database,
    dbLatencyMs,
    telegram:    !!BOT_TOKEN,
    ts:          new Date().toISOString(),
    requests: {
      total:     _botReqTotal,
      errors5xx: _botReq5xx,
      avgMs,
      p50,
      p95,
      window:    sorted.length,
      rpm: {
        current: _botReqTimestamps.filter(t => t >= Date.now() - 60_000).length,
        peak:    _botPeakRpm,
      },
    },
    ordersToday,
    stockCacheAge: _stockCache.ts ? Math.round((Date.now() - _stockCache.ts) / 1000) : null,
    errByTag,
    recentErrors:  BOT_ERR_LOG.slice().reverse().slice(0, 30),
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
  console.log('setWebhook: ok=', res?.ok, res?.description || '');
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
  const BATCH = 25;
  const deadIds = new Set(); // 403 = bot blocked, 400 = invalid chat_id
  for (let i = 0; i < clients.length; i += BATCH) {
    const batch = clients.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((cid, idx) =>
        tg('sendMessage', { chat_id: String(cid), text, parse_mode: 'Markdown' })
          .then(r => { if (!r.ok && (r.error_code === 403 || r.error_code === 400)) deadIds.add(batch[idx]); return r; })
          .catch(e => { console.error(`happyHour …${String(cid).slice(-4)}:`, e.message); return { ok: false }; })
      )
    );
    // Flood limit Telegram: при 429 ждём retry_after, иначе бот блокируется
    // на N секунд, а мы продолжаем слать запросы впустую
    const flood = results.find(r => r && r.error_code === 429 && r.parameters && r.parameters.retry_after);
    if (flood) {
      const waitSec = Math.min(flood.parameters.retry_after, 60);
      console.warn(`happyHour: flood limit, waiting ${waitSec}s`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
    if (i + BATCH < clients.length) await new Promise(r => setTimeout(r, 1100));
  }
  if (deadIds.size > 0) {
    const cleaned = clients.filter(c => !deadIds.has(c));
    setProp('known_clients', JSON.stringify(cleaned));
    console.log(`happyHour: removed ${deadIds.size} dead client IDs`);
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
validateConfig();

app.listen(PORT, async () => {
  console.log(`Bot listening on port ${PORT}`);
  await initDB();             // состояние загружено из PostgreSQL
  await syncCatalogToWarehouse();
  await setWebhook();

  // Таймеры запускаются ПОСЛЕ initDB(), чтобы checkin_sent_date и
  // happy_hour_sent_date были уже загружены — рестарт в нужный час
  // не вызовет повторную отправку.

  // ─── Check-in в 06:00 Минск каждый день ─────────────────────────
  setInterval(() => {
    const msk = new Date(Date.now() + 3 * 3600 * 1000);
    const h   = msk.getUTCHours();
    const m   = msk.getUTCMinutes();
    const dateKey = mskDateKey();
    // Узкое окно 06:00–06:09 вместо 06:00–09:00 — повторный рестарт
    // позже 06:10 не пошлёт второе сообщение.
    if (h === 6 && m < 10 && getProp('checkin_sent_date') !== dateKey) {
      setProp('checkin_sent_date', dateKey);
      sendAdminCheckin().catch(e => console.error('checkin err:', e?.message || String(e)));
    }
  }, 60000);

  // ─── Happy Hour уведомления ──────────────────────────────────────
  setInterval(() => {
    const msk = new Date(Date.now() + 3 * 3600 * 1000);
    const day = msk.getUTCDay();
    const h   = msk.getUTCHours();
    const dateKey   = mskDateKey();
    const isWeekend = day === 0 || day === 6;
    const startH    = isWeekend ? HAPPY_HOUR.weekend.start : HAPPY_HOUR.weekday.start;
    if (h === startH && getProp('happy_hour_sent_date') !== dateKey) {
      setProp('happy_hour_sent_date', dateKey);
      sendHappyHourNotifications().catch(e => console.error('happyHour err:', e?.message || String(e)));
    }
  }, 60000);
});
