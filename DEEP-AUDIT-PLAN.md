# DEEP AUDIT PLAN — MaminHleb_bot

> Методология глубочайшего аудита. Запускается отдельной фазой по этому плану.
> Опирается на `audit.config.yml` (чеклист), `audit.sh` (раннер), `AUDIT-VALIDATION.md` (что уже сверено).
> Стек: Node.js 18+ · Express 4 · Telegram Bot API · PostgreSQL (pg) · helmet · Telegram Mini App.

---

## 0. Принципы (из CLAUDE.md — обязательны)

- Каждый файл читается **целиком**, кусками 500–800 строк через `offset`+`limit`, до последней строки.
- Не делать выводов по частично прочитанному файлу.
- При аудите — **ни один файл не пропускается**.
- Каждая находка = `файл:строка` + воспроизводимое доказательство + severity + CWE/OWASP + конкретный fix.
- Разделять эксплуатируемую уязвимость и code smell. Ложноположительные помечать явно.

---

## 1. Инвентаризация (Phase 0)

| Файл | Объём | Статус прочтения | Приоритет |
|---|---|---|---|
| `bot/index.js` | 889 строк | ✅ прочитан целиком | — |
| `bot/config.js` | 71 строка | ✅ | — |
| `bot/index.html` | **2341 строка** | ⬜ только grep, **НЕ ЦЕЛИКОМ** | **P0** |
| `bot/public/**` | ? | ⬜ | P1 |
| `package.json` / `package-lock.json` | — | ✅ / ⬜ | P1 (SCA) |
| `bot/.env.example` | мал | ✅ | — |
| `*.jpeg` (корень) | — | ⬜ | P2 (мёртвые ассеты?) |

**Действие фазы 0:** `find . -type f -not -path './node_modules/*'` → полная таблица + `wc -l`. Ни один файл не пропускать. Особо: подтвердить, что корневого `index.html` нет (сейчас отсутствует — `audit.sh` guard CRIT-007).

---

## 2. Фазы аудита

### Phase 1 — Mini App deep read (`bot/index.html`) · P0
2341 строка фронтенда в WebView. Читать целиком по 800 строк. Искать:
- **XSS через `innerHTML`:** уже найдены вставки на `:2066, :2133, :2155, :2271, :2496, :2507` — проследить, какие данные туда попадают (товар из CRM, ввод пользователя). Особо опасны `onerror`-атрибуты с подстановкой (`:2155, :2496`).
- **CSP:** меты нет (VAL-BOT-03), helmet CSP отключён (`bot/index.js:16`) — оценить полную поверхность.
- **Доверие к `initDataUnsafe`** (`:1523`): где `user.id` используется как доверенный на клиенте; сверить, что серверу уходит сырой `tg.initData` (`:1522`) для HMAC.
- **Расчёты на клиенте:** цены/скидки/happy-hour — сервер обязан перепроверять (`priceOrder` в `bot/index.js:346` уже считает по серверному CATALOG — подтвердить, что фронт не доверяется).
- **Логика отправки заказа:** заголовки, тело, обработка ответа (старый баг `no-cors` устранён — проверить, что ответ реально читается).

### Phase 2 — Data-flow tracing · P0
Источники → стоки:
- **Источники:** `/order` body, `/webhook` (Telegram update), `/api/order/done`, `/api/orders/history?telegramId`, `/api/admin/checkin`, `/api/stock`, `/api/catalog`, `/api/happyhour`.
- **Стоки:** PostgreSQL (`pgPool.query` — все параметризованы `$1..$N`, подтвердить **каждый**), Telegram `tg()` с `parse_mode:'Markdown'` (инъекция Markdown/разметки через имя/отзыв?), `storageAdapter` ключи.
- Критично: `telegramId` из тела (`bot/index.js:338`) → `chat_id` в `sendMessage` (`:426`) = спуфинг получателя (VAL-BOT-02). Протрассировать полностью.
- `body.items` → `priceOrder` → текст сообщения: проверить экранирование Markdown-спецсимволов.

### Phase 3 — Telegram-специфичная безопасность · P0
- **initData HMAC** (`verifyTgInitData`, `:285`): алгоритм корректен; добавить проверку `auth_date` freshness (VAL-BOT-01).
- **Webhook**: secret token проверяется (`:620`); сравнение не constant-time (VAL-BOT-04); `setWebhook` передаёт `secret_token` (`:824`).
- **Callback data**: `cb.data.split('_')` (`:471`) — валидация длины/формата, дедупликация `cbSeen` (`:50`).
- **Авторизация админ-действий**: `/api/admin/checkin` (WEBHOOK_SECRET) vs `/api/order/done` (ADMIN_SECRET) — несогласованность (VAL-BOT-06).
- **Рассылки**: happy-hour batch (`:855`), отписка заблокировавших бота (403 handling).

### Phase 4 — DB / storage layer · P1
- `storageAdapter` (`:64-105`): гонки при параллельной записи в `_store` + async-запись в PG (eventual consistency); потеря записей при падении до commit.
- Таблицы `bot_state`, `"Order"`, `"Product"` — схема, типы, индексы (общие с CRM — проверить совместимость).
- Параметризация **всех** запросов (выборочно подтверждено — пройти каждый).
- Connection pool (`max:5`, `:60`), таймауты, отсутствие graceful shutdown (нет `SIGTERM` handler — находка).

### Phase 5 — Бизнес-логика · P1
- Дедупликация заказов (`isDuplicateOrder`, `:304`): обход через изменение items/phone; окно 20 сек.
- Атомарность счётчика заказов (`getNextOrderNum`, `:232`): синхронный, но при многоинстансовом деплое — гонки.
- Happy-hour время (`isHappyHourNow`, `:314`): таймзона UTC+3 хардкод, граничные часы.
- Ценообразование (`priceOrder`, `:346`): unknown product отбрасывается — подтвердить, нет ли обхода.

### Phase 6 — SAST/SCA (реальный запуск) · P1
- `npm install -D` плагинов, реальный прогон `eslint --config eslint.config.security.js bot/`.
- `semgrep --config p/owasp-top-ten --config p/nodejs --config p/express`.
- `npm audit` + `osv-scanner` (особо: `node-fetch@2` устарел — VAL/SEC-013, `pg`, `express`).
- `gitleaks detect --log-opts="--all"` по всей истории.

### Phase 7 — Infra / Deploy · P2
- Railway: эфемерная FS — состояние в PG (исправлено), но `cbSeen`/`_store` в памяти теряются при рестарте — оценить影響.
- `trust proxy` (`:14`) — корректность для rate-limit по IP за прокси.
- helmet настроен (`:15`), но CSP/frameguard отключены осознанно (Telegram WebView) — задокументировать обоснование.
- CORS fallback на `*` при пустом origin (`:35`, VAL-BOT-05).
- Env-валидация (`config.js validateConfig`) — что required, что optional.

### Phase 8 — Синтез отчёта
- `DEEP-AUDIT-REPORT.md`: таблица находок (ID, severity, файл:строка, CWE/OWASP, PoC, fix, effort).
- Executive summary + приоритизированный backlog.
- Обновить `audit.config.yml` и добавить guard'ы в `audit.sh`.

---

## 3. Инструменты

| Слой | Инструмент | Команда |
|---|---|---|
| Линт-безопасность | ESLint + security | `eslint --config eslint.config.security.js bot/` |
| SAST | Semgrep | `semgrep --config p/owasp-top-ten --config p/nodejs --config p/express` |
| Секреты (история) | gitleaks | `gitleaks detect --source . --log-opts="--all"` |
| SCA | npm audit / osv-scanner | `npm audit --audit-level=moderate` |
| Раннер-агрегатор | audit.sh | `./audit.sh --ci` |

---

## 4. Критерии готовности (Definition of Done)

- [ ] Каждый файл из инвентаря отмечен «прочитан целиком».
- [ ] `bot/index.html` прочитан до последней строки (2341), все `innerHTML` протрассированы.
- [ ] Таблица всех endpoint'ов × auth × валидация заполнена.
- [ ] Поток `telegramId → chat_id` (спуфинг) разобран с PoC.
- [ ] HMAC initData + auth_date проверены, алгоритм подтверждён.
- [ ] Все инструменты (Phase 6) реально запущены, вывод приложен.
- [ ] gitleaks по всей истории — чисто или находки задокументированы.
- [ ] Каждая находка: `файл:строка` + PoC + fix + severity.
- [ ] Ложноположительные явно помечены.
- [ ] `DEEP-AUDIT-REPORT.md` собран.

---

## 5. Оценка объёма

| Фаза | Условный объём |
|---|---|
| Phase 0 инвентарь | малый |
| Phase 1 Mini App (2341 стр) | **большой** |
| Phase 2 data-flow | средний |
| Phase 3 Telegram-security | средний |
| Phase 4 DB | малый |
| Phase 5 бизнес-логика | средний |
| Phase 6 SAST/SCA (нужен `npm install` + сеть) | средний |
| Phase 7 infra | малый |
| Phase 8 отчёт | средний |

**Узкое место:** Phase 1 (Mini App) и Phase 6 (требует установки инструментов и сетевого доступа).
