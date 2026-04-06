'use strict';
require('dotenv').config();

const express  = require('express');
const fetch    = require('node-fetch');
const { google } = require('googleapis');
const fs       = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

// CORS — Mini App шлёт запросы из браузера
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const BOT_TOKEN        = (process.env.BOT_TOKEN        || '').trim();
const ADMIN_ID         = (process.env.ADMIN_ID         || '').trim();
const DELIVERY_CHAT_ID = (process.env.DELIVERY_CHAT_ID || '').trim();
const PREORDER_CHAT_ID = (process.env.PREORDER_CHAT_ID || '').trim();
const SPREADSHEET_ID   = (process.env.SPREADSHEET_ID   || '').trim();
const PORT             = process.env.PORT || 3000;

// ─── Состояние (память + файл) ────────────────────────────────────────────────
const STATE_FILE = './state.json';
const store      = new Map();
const cbSeen     = new Set();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      Object.entries(data).forEach(([k, v]) => store.set(k, v));
      console.log(`State loaded: ${store.size} keys`);
    }
  } catch(e) { console.error('loadState:', e.message); }
}

function saveState() {
  try {
    const obj = {};
    store.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj));
  } catch(e) { console.error('saveState:', e.message); }
}

function getProp(key)        { return store.get(key) || null; }
function setProp(key, value) { store.set(key, value); saveState(); }
function delProp(key)        { store.delete(key); saveState(); }

// Атомарный счётчик заказов (синхронный — без гонок в event loop Node.js)
function getNextOrderNum() {
  const n = parseInt(getProp('order_counter') || '0') + 1;
  setProp('order_counter', String(n));
  return n;
}

// Инициализация счётчика из Google Sheets при старте (если state.json пуст/сброшен)
async function initOrderCounter() {
  if (parseInt(getProp('order_counter') || '0') > 0) return;
  try {
    const sheets = await getSheets();
    const meta = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:A'
    });
    const rowCount = meta.data.values ? meta.data.values.length : 0;
    const orderCount = Math.max(0, rowCount - 1); // минус строка заголовка
    setProp('order_counter', String(orderCount));
    console.log(`Order counter initialized from Sheets: ${orderCount}`);
  } catch(e) {
    console.error('initOrderCounter:', e.message);
  }
}

// ─── Telegram API ─────────────────────────────────────────────────────────────
const TG_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, payload) {
  try {
    const res = await fetch(`${TG_BASE}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    return res.json();
  } catch(e) {
    console.error(`tg(${method}):`, e.message);
    return { ok: false };
  }
}

// Параллельная отправка — аналог UrlFetchApp.fetchAll
async function tgAll(calls) {
  return Promise.all(calls.map(([method, payload]) => tg(method, payload)));
}

// ─── Google Sheets ────────────────────────────────────────────────────────────
let sheetsApi = null;

async function getSheets() {
  if (sheetsApi) return sheetsApi;
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsApi = google.sheets({ version: 'v4', auth });
  return sheetsApi;
}

async function appendRow(values) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            'A:N',
    valueInputOption: 'USER_ENTERED',
    resource:         { values: [values] }
  });
  // Надёжно: считаем реальное количество строк в колонке A
  const meta = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         'A:A'
  });
  const rowCount = meta.data.values ? meta.data.values.length : 0;
  console.log('appendRow rowCount:', rowCount);
  return rowCount;
}

async function updateCell(row, col, value) {
  const sheets = await getSheets();
  const colLetter = String.fromCharCode(64 + col); // 1=A, 10=J, 12=L
  await sheets.spreadsheets.values.update({
    spreadsheetId:   SPREADSHEET_ID,
    range:           `${colLetter}${row}`,
    valueInputOption: 'USER_ENTERED',
    resource:        { values: [[value]] }
  });
}

// ─── Дедупликация заказов (файловое хранилище — работает между экземплярами) ──
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
  if (isDuplicateOrder(body)) { console.log('Duplicate order ignored'); return; }
  const isPreorder = body.type === 'Предзаказ';
  const clientId   = String(body.telegramId || '0');
  const clientName = body.name || 'Гость';

  // Состав — новый стиль с ◆
  let itemsText = '';
  let total = 0;
  try {
    const parsed = typeof body.items === 'string' ? JSON.parse(body.items) : body.items;
    if (Array.isArray(parsed)) {
      itemsText = parsed.map(i => {
        total += i.price * i.quantity;
        return `◆ ${i.product_name} x${i.quantity} — ${(i.price * i.quantity).toFixed(2)} руб.`;
      }).join('\n');
    } else {
      itemsText = String(body.items || '');
    }
  } catch(e) {
    itemsText = String(body.items || '');
  }

  const totalStr = (total > 0 ? total.toFixed(2) : Number(body.total || 0).toFixed(2)) + ' руб.';

  // Блок доставки / предзаказа
  let deliveryBlock = '';
  if (isPreorder && body.time && body.time !== 'undefined') {
    const [rawDate, rawTime] = body.time.split(' в ');
    const dp = (rawDate || '').split('-');
    const niceDate = dp.length === 3 ? `${dp[2]}.${dp[1]}.${dp[0]}` : rawDate;
    deliveryBlock = `*ПРЕДЗАКАЗ:*\n📅 Дата: ${niceDate}\n🕐 Время: ${rawTime || ''}`;
  } else if (body.address && body.address !== 'undefined' && body.address !== 'Самовывоз') {
    const payLabel = body.payment === 'card' ? '💳 Картой' : body.payment === 'cash' ? '💵 Наличными' : '';
    deliveryBlock = `*АДРЕС ДОСТАВКИ:*\n🚕 ${body.address}${payLabel ? `\n${payLabel}` : ''}`;
  } else if (body.time && body.time !== 'undefined') {
    deliveryBlock = `*САМОВЫВОЗ:*\n📍 г. Витебск, пр-т Московский 130\n🕐 Время: ${body.time}`;
  } else {
    deliveryBlock = `*САМОВЫВОЗ:*\n📍 г. Витебск, пр-т Московский 130`;
  }
  // deliveryInfo нужен для совместимости с fallback-проверкой типа заказа
  const deliveryInfo = deliveryBlock;

  // Тексты
  const noteStr  = (body.note || '').trim();
  const noteLine = noteStr ? `\n💬 *ПРИМЕЧАНИЕ:* ${noteStr}\n` : '';

  // Запись в Google Sheets
  const now     = new Date();
  const dateStr = now.toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' });

  const newRow = await appendRow([
    dateStr,
    !isPreorder ? '✅ Заказ'      : '',
    isPreorder  ? '📌 Предзаказ' : '',
    clientName,
    clientId,
    body.phone || '-',
    itemsText,
    totalStr,
    deliveryBlock,
    '', '', '🟡 Новый', '',
    noteStr
  ]);

  if (!newRow) { console.error('appendRow: failed to get row number'); return; }

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

  // тип заказа — нужен для заголовка и кнопок
  const isDeliveryAddr = body.address && body.address !== 'Самовывоз' && body.address !== 'undefined';
  const orderType = isPreorder ? 'preorder'
    : (body.deliveryMethod === 'delivery' || isDeliveryAddr) ? 'delivery' : 'pickup';
  setProp(`order_type_${newRow}`, orderType);
  console.log(`Order ${orderNum} type=${orderType} deliveryMethod=${body.deliveryMethod} address=${body.address}`);

  // Заголовок (меняется вместе со статусом) и тело (статично)
  const orderTypeLabel = isPreorder ? 'ПРЕДЗАКАЗ' : orderType === 'delivery' ? 'ДОСТАВКА' : 'НОВЫЙ ЗАКАЗ';
  const adminHeader = `🥐 *${orderTypeLabel} — №${orderNum}*`;
  const adminBody   =
    `\n*КЛИЕНТ:*\n` +
    `👤 ${clientName}\n` +
    `📞 ${body.phone || '—'}\n` +
    `\n${deliveryBlock}\n` +
    `\n*ПОЗИЦИИ:*\n` +
    `${itemsText}\n` +
    `━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n` +
    `💰 *Сумма заказа:* ${totalStr}` +
    noteLine;

  const adminBase = adminHeader;

  setProp(`receipt_base_${newRow}`, receiptBase);
  setProp(`admin_base_${newRow}`,   adminBase);
  setProp(`admin_body_${newRow}`,   adminBody);
  setProp(`client_name_${newRow}`,  clientName);
  setProp(`order_num_${newRow}`,    String(orderNum));
  setProp(`order_phone_${newRow}`,   body.phone   || '—');
  setProp(`order_address_${newRow}`, body.address || 'Самовывоз');
  setProp(`order_total_${newRow}`,   totalStr);

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

  // Параллельная отправка
  const calls = [];
  if (clientId !== '0') {
    calls.push(['sendMessage', {
      chat_id:    clientId,
      text:       receiptBase,
      parse_mode: 'Markdown'
    }]);
  }

  if (isPreorder && PREORDER_CHAT_ID) {
    // Предзаказ идёт ТОЛЬКО в чат предзаказов, не админу
    const [rawDate, rawTime] = (body.time || '').split(' в ');
    const dp = (rawDate || '').split('-');
    const niceDate = dp.length === 3 ? `${dp[2]}.${dp[1]}.${dp[0]}` : rawDate;
    const preorderText =
      `📌 *ПРЕДЗАКАЗ — №${orderNum}*\n🟡 Статус: Новый\n\n` +
      `👤 ${clientName}\n` +
      `📞 ${body.phone || '—'}\n` +
      `📅 ${niceDate}  🕐 ${rawTime || '—'}\n\n` +
      `*Состав:*\n${itemsText}\n\n` +
      `💰 ${totalStr}`;
    calls.push(['sendMessage', {
      chat_id:      PREORDER_CHAT_ID,
      text:         preorderText,
      parse_mode:   'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Принять заказ', callback_data: `accept_${newRow}_${clientId}` },
        { text: '❌ Отклонить',     callback_data: `decline_${newRow}_${clientId}` }
      ]]}
    }]);
  } else {
    // Обычный заказ или предзаказ без настроенного чата — идёт админу
    calls.push(['sendMessage', {
      chat_id:      ADMIN_ID,
      text:         `${adminBase}\n🟡 Статус: Новый${adminBody}`,
      parse_mode:   'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Принять заказ', callback_data: `accept_${newRow}_${clientId}` },
        { text: '❌ Отклонить',     callback_data: `decline_${newRow}_${clientId}` }
      ]]}
    }]);
  }

  const responses = await tgAll(calls);
  let offset = 0;

  if (clientId !== '0') {
    const r = responses[0];
    if (r.ok) setProp(`receipt_${newRow}`,
      JSON.stringify({ chatId: clientId, msgId: r.result.message_id }));
    offset = 1;
  }

  const adminR = responses[offset];
  if (adminR.ok) {
    const chatId = (isPreorder && PREORDER_CHAT_ID) ? PREORDER_CHAT_ID : ADMIN_ID;
    setProp(`admin_msg_${newRow}`, JSON.stringify({ chatId, msgId: adminR.result.message_id }));
  }
}

// ─── Вспомогательные функции статусов ────────────────────────────────────────

// Обновить сообщение админа: новый текст + новые кнопки
// adminBase = заголовок (первая строка), adminBody = тело сообщения
async function editAdminMsg(adminChatId, adminMsgId, adminBase, statusLine, keyboard, adminBody) {
  const body = adminBody || '';
  return tg('editMessageText', {
    chat_id:      adminChatId,
    message_id:   adminMsgId,
    text:         `${adminBase}\n${statusLine}${body}`,
    parse_mode:   'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Отправить уведомление клиенту (если есть)
async function notifyClient(clientId, text, keyboard) {
  if (!clientId || clientId === '0') return null;
  return tg('sendMessage', {
    chat_id:      String(clientId),
    text,
    parse_mode:   'Markdown',
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

// Удалить сохранённое сообщение клиенту (если было)
async function deleteStoredMsg(key) {
  const raw = getProp(key);
  if (!raw) return;
  const info = JSON.parse(raw);
  await tg('deleteMessage', { chat_id: info.chatId, message_id: info.msgId });
  delProp(key);
}

// Кнопки для рейтинга
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
    chat_id:      ADMIN_ID,
    text:         `☀️ *Доброе утро!*\n\nКто сегодня работает администратором?\nНажмите кнопку и введите имя.`,
    parse_mode:   'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '✏️ Ввести имя', callback_data: 'checkin_start' }]] }
  });
  if (r.ok) setProp('checkin_msg', JSON.stringify({ chatId: ADMIN_ID, msgId: r.result.message_id }));
}

// ─── Обработка кнопок ─────────────────────────────────────────────────────────
async function handleCallback(cb) {
  await tg('answerCallbackQuery', { callback_query_id: String(cb.id), text: '', show_alert: false });

  if (cbSeen.has(cb.id)) return;
  cbSeen.add(cb.id);
  if (cbSeen.size > 10000) Array.from(cbSeen).slice(0, 1000).forEach(id => cbSeen.delete(id));

  const parts    = cb.data.split('_');
  const action   = parts[0];

  // ── Check-in администратора ───────────────────────────────────────────────
  if (action === 'checkin') {
    const r = await tg('sendMessage', {
      chat_id:    String(cb.from.id),
      text:       '✏️ Введите ваше имя:',
      parse_mode: 'Markdown'
    });
    setProp(`pending_checkin_${cb.from.id}`, JSON.stringify({ promptMsgId: r?.ok ? r.result.message_id : null }));
    // Убираем кнопку с исходного сообщения
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

    const existingRaw = getProp(`pending_${cb.from.id}`);
    if (existingRaw) {
      const ep = JSON.parse(existingRaw);
      if (ep.reviewReqMsgId) {
        setProp(`pending_${cb.from.id}`,
          JSON.stringify({ stars, rowNum: ratingRow, reviewReqMsgId: ep.reviewReqMsgId }));
        await updateCell(ratingRow, 10, starStr);
        return;
      }
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
    await updateCell(ratingRow, 10, starStr);
    return;
  }

  const rowNum      = parseInt(parts[1]);
  const clientId    = parts[2];
  const orderNum    = getProp(`order_num_${rowNum}`) || String(rowNum - 1);
  const adminChatId = cb.message?.chat?.id || ADMIN_ID;
  const adminMsgId  = cb.message?.message_id;
  const adminBase   = getProp(`admin_base_${rowNum}`) || '';
  const adminBody   = getProp(`admin_body_${rowNum}`) || '';
  const orderType   = getProp(`order_type_${rowNum}`) || 'pickup'; // delivery | pickup | preorder

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

    await updateCell(rowNum, 12, '✅ Принят');
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

    await updateCell(rowNum, 12, '👨‍🍳 В работе');
    return;
  }

  // ── 3. Готов ──────────────────────────────────────────────────────────────
  if (action === 'ready') {
    await deleteStoredMsg(`accept_msg_${rowNum}`);
    await deleteStoredMsg(`working_msg_${rowNum}`);

    const isDeliveryOrder = orderType === 'delivery' || adminBase.includes('ДОСТАВКА');
    console.log(`ready: rowNum=${rowNum} orderType=${orderType} isDeliveryOrder=${isDeliveryOrder}`);

    if (isDeliveryOrder) {
      // Доставка: ждём подтверждения курьера
      await editAdminMsg(adminChatId, adminMsgId, adminBase, 'Готов ✅', [[
        { text: '🚗 Отправить доставку', callback_data: `courier_${rowNum}_${clientId}` }
      ]], adminBody);
      const r = await notifyClient(clientId,
        `🍞 *Заказ №${orderNum} готов!*\n\nПередаём курьеру — скоро будет у вас.`);
      if (r?.ok) setProp(`ready_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
      await updateCell(rowNum, 12, '🍞 Готов');
    } else {
      // Самовывоз: завершаем сразу, отправляем оценку
      await editAdminMsg(adminChatId, adminMsgId, adminBase, 'Готов ✅', [], adminBody);
      const readyText = orderType === 'preorder'
        ? `🍞 *Ваш предзаказ №${orderNum} готов!*\n\n📍 Ждём вас по адресу: г. Витебск, пр-т Московский 130\n\nСпасибо, что выбрали нас! Желаем вам хорошего и продуктивного дня ☀️\n\n⭐ *Оцените качество обслуживания:*`
        : `🍞 *Ваш заказ №${orderNum} готов!*\n\n📍 Ждём вас по адресу: г. Витебск, пр-т Московский 130\n\n⭐ *Оцените качество обслуживания:*`;
      const r = await notifyClient(clientId, readyText, ratingKeyboard(rowNum));
      if (r?.ok) setProp(`done_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));
      await updateCell(rowNum, 12, '🍞 Готов');
    }
    return;
  }

  // ── 4a. Передан курьеру (доставка) ───────────────────────────────────────
  if (action === 'courier') {
    await deleteStoredMsg(`ready_msg_${rowNum}`);

    // У админа — статус «В доставке», кнопок нет
    await editAdminMsg(adminChatId, adminMsgId, adminBase, '🚗 В доставке', [], adminBody);

    // Сообщение в чат доставки с кнопкой «Доставлен»
    if (DELIVERY_CHAT_ID) {
      const phone   = getProp(`order_phone_${rowNum}`)   || '—';
      const address = getProp(`order_address_${rowNum}`) || '—';
      const total   = getProp(`order_total_${rowNum}`)   || '—';
      const name    = getProp(`client_name_${rowNum}`)   || '—';
      const deliveryText =
        `🚗 *ДОСТАВКА — №${orderNum}*\n\n` +
        `👤 ${name}\n` +
        `📞 ${phone}\n` +
        `📍 ${address}\n` +
        `💰 ${total}`;
      const dr = await tg('sendMessage', {
        chat_id:      DELIVERY_CHAT_ID,
        text:         deliveryText,
        parse_mode:   'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Доставлен', callback_data: `done_${rowNum}_${clientId}` }
        ]]}
      });
      if (dr.ok) setProp(`delivery_msg_${rowNum}`, JSON.stringify({ chatId: DELIVERY_CHAT_ID, msgId: dr.result.message_id }));
    }

    // Уведомление клиенту
    await notifyClient(clientId,
      `🚗 *Заказ №${orderNum} отправлен!*\n\n⏱ Ориентировочное время доставки: *30–45 минут* в зависимости от загруженности.\nПо приезде заказа, курьер с вами свяжется!\n\nС уважением команда «Мамин Хлеб»\nЕсли возникли вопросы звоните по номеру:\n☎️ +375(29)722-20-22`);

    await updateCell(rowNum, 12, '🚗 В доставке');
    return;
  }

  // ── 4b. Доставлен (нажимает доставщик в чате доставки) ───────────────────
  if (action === 'done') {
    await deleteStoredMsg(`ready_msg_${rowNum}`);

    // Убрать кнопку из сообщения в чате доставки
    const deliveryMsgRaw = getProp(`delivery_msg_${rowNum}`);
    if (deliveryMsgRaw) {
      const dm = JSON.parse(deliveryMsgRaw);
      await tg('editMessageReplyMarkup', { chat_id: dm.chatId, message_id: dm.msgId, reply_markup: { inline_keyboard: [] } });
      delProp(`delivery_msg_${rowNum}`);
    }

    // Обновить сообщение у АДМИНА (берём из state, т.к. callback пришёл из чата доставки)
    const adminMsgRaw = getProp(`admin_msg_${rowNum}`);
    const storedAdmin = adminMsgRaw ? JSON.parse(adminMsgRaw) : null;
    const targetChatId = storedAdmin ? storedAdmin.chatId : adminChatId;
    const targetMsgId  = storedAdmin ? storedAdmin.msgId  : adminMsgId;
    await editAdminMsg(targetChatId, targetMsgId, adminBase, '✅ Доставлен', [], adminBody);

    // Уведомление клиенту + оценка
    const r = await notifyClient(clientId,
      `🎉 *Ваш заказ №${orderNum} доставлен!*\n\nСпасибо, что выбрали нас! 🍞\n\n⭐ *Оцените качество обслуживания:*`,
      ratingKeyboard(rowNum));
    if (r?.ok) setProp(`done_msg_${rowNum}`, JSON.stringify({ chatId: String(clientId), msgId: r.result.message_id }));

    await updateCell(rowNum, 12, '✅ Доставлен');
    return;
  }

  // ── 5. Отклонить / Отменить ───────────────────────────────────────────────
  if (action === 'decline' || action === 'cancel') {
    const label = action === 'cancel' ? '🚫 Отменён' : '❌ Отклонён';
    const clientText = action === 'cancel'
      ? `🚫 *Ваш заказ №${orderNum} отменён.*\n\nПриносим извинения. Обратитесь к нам напрямую.`
      : `❌ *Ваш заказ №${orderNum} отклонён.*\n\nПриносим извинения. Свяжитесь с нами.`;

    // Удаляем все промежуточные уведомления
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

    await updateCell(rowNum, 12, label);
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

    await updateCell(rowNum, 12, '🟡 Новый');
    delProp(`decline_msg_${rowNum}`);
    return;
  }
}

// ─── Обработка текстовых сообщений (отзыв) ───────────────────────────────────
async function handleTextMessage(message) {
  const senderId = String(message.from.id);
  const msgText  = message.text.trim();

  // Дедупликация
  const msgKey = `msg_${message.message_id}`;
  if (getProp(msgKey)) return;
  setProp(msgKey, '1');

  // ── Check-in администратора ─────────────────────────────────────────────
  const checkinRaw = getProp(`pending_checkin_${senderId}`);
  if (checkinRaw) {
    const cd = JSON.parse(checkinRaw);
    if (cd.promptMsgId) await tg('deleteMessage', { chat_id: senderId, message_id: cd.promptMsgId });
    await tg('sendMessage', {
      chat_id:    senderId,
      text:       `✅ Записано! Сегодня работает: *${msgText}*`,
      parse_mode: 'Markdown'
    });
    // Логируем в Google Sheets
    try {
      const sheets = await getSheets();
      const now = new Date();
      const dateStr = now.toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
      await sheets.spreadsheets.values.append({
        spreadsheetId:    SPREADSHEET_ID,
        range:            'Журнал!A:B',
        valueInputOption: 'USER_ENTERED',
        resource:         { values: [[dateStr, msgText]] }
      });
    } catch(e) { console.error('checkin sheet:', e.message); }
    delProp(`pending_checkin_${senderId}`);
    return;
  }

  const pendingRaw = getProp(`pending_${senderId}`);
  if (!pendingRaw) return;

  const data    = JSON.parse(pendingRaw);
  const starStr = '⭐'.repeat(data.stars) + ` (${data.stars}/5)`;
  const isSkip  = msgText === '/skip';

  const calls = [];
  if (data.reviewReqMsgId) calls.push(['deleteMessage',
    { chat_id: senderId, message_id: data.reviewReqMsgId }]);
  calls.push(['sendMessage', {
    chat_id:    senderId,
    text:       isSkip
      ? '🙏 *Спасибо за оценку!* Рады видеть вас снова 🍞'
      : '🙏 *Спасибо за отзыв!*',
    parse_mode: 'Markdown'
  }]);

  if (calls.length > 0) await tgAll(calls);

  await updateCell(data.rowNum, 10, isSkip ? starStr : `${starStr}\n💬 ${msgText}`);
  delProp(`pending_${senderId}`);
}

// ─── Ответ из Google Sheets колонки K → клиенту ───────────────────────────────
// Этот маршрут вызывается вручную или через GAS-триггер
app.post('/reply', async (req, res) => {
  res.json({ ok: true });
  const { telegramId, replyText, row } = req.body;
  if (!telegramId || !replyText) return;
  const result = await tg('sendMessage', {
    chat_id:    String(telegramId),
    text:       `✉️ *Сообщение от пекарни «Мамин Хлеб»:*\n\n${replyText}`,
    parse_mode: 'Markdown'
  });
  // Если передан номер строки — обновляем колонку M (13)
  if (row && result.ok) await updateCell(parseInt(row), 13, '✅ Ответили');
});

// ─── Маршруты ─────────────────────────────────────────────────────────────────

// Telegram webhook — отвечаем 200 сразу, обрабатываем асинхронно
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (!body) return;
  if (body.callback_query) {
    handleCallback(body.callback_query).catch(e => console.error('callback err:', e));
  } else if (body.message?.text) {
    handleTextMessage(body.message).catch(e => console.error('message err:', e));
  }
});

// Заказы из Mini App (Content-Type: text/plain с JSON-телом)
app.post('/order', (req, res) => {
  res.json({ ok: true });
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return; }
  }
  if (!body || (!body.phone && !body.items)) return;
  handleOrder(body).catch(e => console.error('order err:', e));
});

// Проверка работоспособности
app.get('/', (req, res) => res.send('MaminHleb bot is running ✓'));

// ─── Установка вебхука (вызывается один раз при старте) ───────────────────────
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
    drop_pending_updates: true,
    max_connections:      40
  });
  console.log('setWebhook:', JSON.stringify(res));
}

// ─── Ежедневный check-in в 22:00 ─────────────────────────────────────────────
let checkinSentDate = '';
setInterval(() => {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const h   = msk.getUTCHours();
  const m   = msk.getUTCMinutes();
  const dateKey = `${msk.getUTCFullYear()}-${msk.getUTCMonth()}-${msk.getUTCDate()}`;
  if (h === 6 && m < 5 && checkinSentDate !== dateKey) {
    checkinSentDate = dateKey;
    sendAdminCheckin().catch(e => console.error('checkin err:', e));
  }
}, 60000);

// ─── Happy Hour уведомления ───────────────────────────────────────────────────
// Пн–Пт 19:00 и Сб–Вс 17:00 (время Минска UTC+3) — рассылка всем клиентам
let happyHourSentDate = '';

async function sendHappyHourNotifications() {
  const clientsRaw = getProp('known_clients') || '[]';
  let clients = [];
  try { clients = JSON.parse(clientsRaw); } catch(e) {}
  if (!clients.length) { console.log('happyHour: no clients to notify'); return; }
  console.log(`happyHour: sending to ${clients.length} clients`);
  const text =
    `🌆 *Добрый вечер!*\n\n` +
    `Настало время счастливого часа — скидка *30%* на всю оставшуюся продукцию для самовывоза.\n\n` +
    `Успейте забрать! 🥐`;
  for (const cid of clients) {
    try { await tg('sendMessage', { chat_id: String(cid), text, parse_mode: 'Markdown' }); }
    catch(e) { console.error(`happyHour notify ${cid}:`, e.message); }
  }
}

setInterval(() => {
  const now = new Date();
  // Belarus = UTC+3 постоянно (без DST) — не зависит от ICU данных сервера
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const day = msk.getUTCDay();      // 0=Вс … 6=Сб
  const h   = msk.getUTCHours();
  const m   = msk.getUTCMinutes();
  const dateKey = `${msk.getUTCFullYear()}-${msk.getUTCMonth()}-${msk.getUTCDate()}`;
  const isWeekday = day >= 1 && day <= 5;
  const isWeekend = day === 0 || day === 6;
  // Проверяем первые 5 минут счастливого часа — не пропустим даже при перезапуске бота
  const isHappyStart = (isWeekday && h === 19 && m < 5) || (isWeekend && h === 17 && m < 5);
  if (isHappyStart && happyHourSentDate !== dateKey) {
    happyHourSentDate = dateKey;
    sendHappyHourNotifications().catch(e => console.error('happyHour err:', e));
  }
}, 60000);

// ─── Запуск ───────────────────────────────────────────────────────────────────
loadState();
app.listen(PORT, async () => {
  console.log(`Bot listening on port ${PORT}`);
  await initOrderCounter();
  await setWebhook();
});
