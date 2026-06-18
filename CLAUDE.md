# CLAUDE.md — MaminHleb_bot

## Проект
Telegram-бот и Mini App для пекарни "Мамин Хлеб". Node.js, Express, PostgreSQL
(через pg напрямую — без ORM), Telegram Bot API.

## Правила чтения файлов

- Читай файлы ПОЛНОСТЬЮ, кусками по 500–800 строк с использованием `offset` + `limit`
- Не останавливайся пока не дочитаешь файл до последней строки
- Не делай выводов и не пиши код на основе частично прочитанного файла
- Для файлов длиннее 500 строк: сначала прочитай весь файл целиком, затем анализируй
- При аудите или ревью — читать ВСЕ файлы проекта, не пропускать ни один

## Ключевые файлы

- `bot/index.js` — основной бэкенд бота
- `bot/index.html` — PRODUCTION Mini App (единственный файл фронтенда)
- `bot/public/fonts/` — самохостинг Google Fonts (Montserrat, Playfair Display, Poppins)
- `bot/.env.example` — переменные окружения
- `AUDIT.md` — результаты аудита v2.2, 204 проблемы

## Архитектура (после security-аудита)

- **Хранилище**: PostgreSQL таблица `bot_state` (key/value + TTL); state.json удалён
- **Auth**: `X-Telegram-Bot-Api-Secret-Token` на `/webhook`; `X-Admin-Secret` на `/health` и `/api/order/done`
- **initData**: HMAC-SHA256 верификация; закрыто в closure (`_tgInitData`), не на `window`
- **CORS**: ограничен по origin; `trust proxy 1` задокументирован
- **Поля заказа**: длина ограничена (phone 30, name 100, address 300, note 500)
- **HTML**: `escHtml()` — 5-символьное экранирование для Telegram-сообщений
- **Шрифты**: самохостинг через `bot/public/fonts/fonts.css`, без запросов к google.com

## Статус багов (все исправлено в аудите)

- ✅ `mode: 'no-cors'` — исправлен на стандартный fetch с обработкой ответа
- ✅ `Access-Control-Allow-Origin: *` — ограничен whitelist-ом
- ✅ `/webhook` без проверки секрета — `X-Telegram-Bot-Api-Secret-Token` добавлен
- ✅ `state.json` на ephemeral FS — заменён на PostgreSQL `bot_state`
- ✅ `initDataUnsafe.user.id` как доверенный ID — заменён на верифицированный initData
- ✅ `valueInputOption: USER_ENTERED` — Google Sheets удалены, данные в PostgreSQL
- ✅ Два файла Mini App — `index.html` в корне удалён, единственный файл `bot/index.html`
- ✅ Google Fonts — самохостинг, CSP больше не разрешает fonts.googleapis.com
