# CLAUDE.md — MaminHleb_bot

## Проект
Telegram-бот и Mini App для пекарни "Мамин Хлеб". Node.js, Express, Google Sheets API, Telegram Bot API, файловое хранилище состояния (state.json).

## Правила чтения файлов

- Читай файлы ПОЛНОСТЬЮ, кусками по 500–800 строк с использованием `offset` + `limit`
- Не останавливайся пока не дочитаешь файл до последней строки
- Не делай выводов и не пиши код на основе частично прочитанного файла
- Для файлов длиннее 500 строк: сначала прочитай весь файл целиком, затем анализируй
- При аудите или ревью — читать ВСЕ файлы проекта, не пропускать ни один

## Ключевые файлы

- `bot/index.js` — 1195 строк, основной бэкенд бота
- `bot/index.html` — 2341 строка, PRODUCTION Mini App (именно этот файл раздаётся)
- `index.html` — 2440 строк, НЕ используется в production (мёртвый файл)
- `bot/.env.example` — переменные окружения (неполный список)
- `AUDIT.md` — результаты аудита v2.2, 204 проблемы

## Известные критические баги

- `bot/index.html:2315` — `mode: 'no-cors'`, ответ сервера никогда не читается
- `bot/index.js:17` — `Access-Control-Allow-Origin: *`, открытый CORS
- `bot/index.js:920` — `/webhook` без проверки `X-Telegram-Bot-Api-Secret-Token`
- `bot/index.js:39` — `state.json` несовместим с ephemeral FS Railway
- `bot/index.html:831` — `initDataUnsafe.user.id` используется как доверенный идентификатор
- `bot/index.js:146,169,758,907` — `valueInputOption: USER_ENTERED`, риск formula injection
- Два расходящихся файла Mini App: `bot/index.html` (prod) и `index.html` (мёртвый)
