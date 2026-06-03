# DEEP AUDIT REPORT — MaminHleb_bot

> Живой отчёт глубокого аудита. Методология: `DEEP-AUDIT-PLAN.md`. Ранее сверенное: `AUDIT-VALIDATION.md`.
> Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO. Каждая находка: `файл:строка` + суть + fix.

**Старт:** 2026-06-02

---

## Phase 0 — Инвентаризация и прогресс чтения

| Файл | Строк | Прочитан | Примечание |
|---|---|---|---|
| `bot/index.js` | 888 | ✅ | backend, см. AUDIT-VALIDATION.md |
| `bot/config.js` | 70 | ✅ | env-схема, чисто |
| `bot/index.html` | **4415** ⚠️ | ✅ (стоки+потоки+grep) | CLAUDE.md говорил 2341; Mini App |
| `bot/.env.example` | 44 | ✅ | — |
| `bot/public/images/*` | бинарь | n/a | дубликаты + корневые дубли |
| корневые `*.jpeg` | бинарь | n/a | мёртвые дубли `bot/public/images/` |

---

## Phase 1 — Mini App (`bot/index.html`, 4415 строк)

**Покрытие:** прочитаны Telegram-init, все 39 `innerHTML`-стоков с трассировкой источников,
определение `escHtml`, потоки `/order`, `/review`, `/api/orders/history`, рендер истории/отзывов/рефералов.

### ✅ Сильные стороны (подтверждено)
- **`escHtml` корректен** (`:1638-1640`, экранирует `& < > " '`) и **применяется** ко всем пользовательским данным в `innerHTML`: отзывы (`:4241-4242`), рефералы (`:4293-4294`), история заказов (`:4126-4153`, поля `addr/status/date/orderNum`).
- **Каталог товаров и список улиц — статические константы** в файле (`:1535+`, `:3170+`), не пользовательский ввод → `innerHTML` по ним не XSS.
- `/order` (`:4326-4342`) шлёт `tgInitData` → сервер верифицирует личность по HMAC (`index.js:330-342`).

### DA-BOT-01 · IDOR: чужая история заказов по `telegramId` — HIGH
- **CWE-639**, OWASP A01:2021. (Усиливает VAL-BOT-02 конкретным вектором.)
- `:4173-4175` — `tid = String(telegramId||'0')` (из `initDataUnsafe`, клиентский) → `fetch('/api/orders/history?telegramId=' + tid)` **без `tgInitData`**.
- Сервер `index.js:730-748` — `SELECT … WHERE "telegramId" = $1` по параметру, **без auth и без верификации**, что запрашивающий = владелец.
- Итог: подменив `telegramId` в запросе, любой получает чужую историю: **имя, телефон, адрес, состав, суммы** (перебор по числовым Telegram-ID).
- **Fix:** не принимать `telegramId` из query; извлекать его на сервере из верифицированного `tgInitData` (HMAC), как в `/order`.

### DA-BOT-02 · Tailwind и Telegram-SDK с CDN без SRI — MEDIUM
- **CWE-829 (supply chain)**, OWASP A08:2021.
- `:8` `https://cdn.tailwindcss.com/3.4.17` — Tailwind **Play CDN** грузится в рантайме (официально «не для продакшена») без SRI; компрометация CDN → произвольный JS в Mini App (внутри Telegram WebView).
- `:7` `https://telegram.org/js/telegram-web-app.js` — без SRI (но домен доверенный/обязательный).
- **Fix:** собрать Tailwind в статический CSS на этапе сборки; для внешних скриптов — `integrity`+`crossorigin` или self-host.

### DA-BOT-03 · Отсутствующие роуты `/review` и `/api/config` (404) — MEDIUM
- `:4253` `fetch('/review', …)` и `:2969` `fetch('${API_BASE}/api/config')` — этих маршрутов **нет** в `index.js` (есть только `/webhook, /order, /api/order/done, /api/orders/history, /api/stock, /api/catalog, /api/happyhour, /, /api/admin/checkin, /health`).
- Отзыв из Mini App уходит в `/review` → 404, ошибка **молча проглатывается** (`:4262` `.catch(()=>{})`) → отзывы клиентов **теряются** (видны только локально через `reviews.unshift`).
- `/api/config` → 404 → откат на дефолты (деградация конфигурации).
- **Fix:** реализовать `/review` (с верификацией `tgInitData`, запись в БД) и `/api/config`, либо убрать мёртвые клиентские вызовы.

### DA-BOT-04 · Инъекция в инлайновый `onerror` через поля товара — LOW
- `:2155, :2496, :4080` — `innerHTML` строит `onerror="…'+product.name+'…'+product.image+'…"` (имя/эмодзи товара внутри inline-обработчика).
- Сейчас товары статичны → не эксплуатируется. **Хрупко:** если каталог станет динамическим (из БД/CRM) без экранирования под JS-контекст — XSS.
- **Fix:** не строить inline-`onerror` из данных; вешать обработчик через `addEventListener`, эмодзи в `textContent`.

### DA-BOT-05 · Нет CSP при 39 `innerHTML` — MEDIUM (= VAL-BOT-03)
- Меты CSP нет (`:1-12`), helmet CSP отключён (`index.js:16`). При 39 точках `innerHTML` любой будущий неэкранированный сток = XSS без сетки безопасности.
- **Fix:** добавить строгую CSP-мету (`script-src 'self' https://telegram.org`), что заодно подсветит CDN-зависимость (DA-BOT-02).

### Подтверждение VAL-BOT-02 (спуфинг telegramId)
- `/order` шлёт `tgInitData` (верифицируется) — в штатном потоке ок. Но серверный fallback на `body.telegramId` (`index.js:338`) остаётся: при пустом/битом initData личность подделывается. Плюс DA-BOT-01 — отдельный неверифицированный путь.

---

## Ссылки на backend-находки
Полный разбор `index.js`/`config.js` — в **AUDIT-VALIDATION.md** (VAL-BOT-01..06):
initData без `auth_date`, спуфинг telegramId, CSP/XSS, не-constant-time секреты, CORS `*`-fallback, рассогласование admin-секретов.

## Сводка (Mini App)
| Severity | Находки |
|---|---|
| HIGH | DA-BOT-01 |
| MEDIUM | DA-BOT-02, DA-BOT-03, DA-BOT-05 |
| LOW | DA-BOT-04 |
| Позитив | escHtml корректен и применяется; каталог/улицы статичны; /order верифицирует initData |
