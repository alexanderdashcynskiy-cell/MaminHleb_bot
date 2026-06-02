# AUDIT VALIDATION — MaminHleb_bot

> Сверка `audit.config.yml` с **живым кодом** на 2026-06-02.
> Файлы прочитаны целиком: `bot/index.js` (889 строк), `bot/config.js`, `bot/index.html` (grep по ключевым паттернам), `package.json`.
> Этот документ фиксирует **фактический** статус, а не предположения из `CLAUDE.md`/`AUDIT.md`.

## TL;DR

`CLAUDE.md` описывает бота на **state.json + Google Sheets** с открытым CORS и
webhook без проверки. Реальный код уже на **PostgreSQL** (`pg`), с helmet,
rate-limit, проверкой webhook-секрета и HMAC-валидацией Telegram initData.
Семь «известных багов» закрыты. Реальные находки — другие, более тонкие.

---

## ✅ RESOLVED — «известные критические баги» уже исправлены

| Заявлено в CLAUDE.md | Факт в коде | Доказательство |
|---|---|---|
| `index.html:2315` `mode:'no-cors'` | в `bot/index.html` `no-cors` нет | grep `no-cors` → not found |
| `index.js:17` CORS `*` | origin ограничен `.telegram.org` | `bot/index.js:27-41` валидация origin |
| `index.js:920` webhook без секрета | секрет проверяется | `bot/index.js:620-626` `x-telegram-bot-api-secret-token` |
| `index.js:39` state.json на ephemeral FS | состояние в PostgreSQL | `bot/index.js:64-105` `storageAdapter` + `bot_state` |
| `index.html:831` initDataUnsafe как trusted | сервер проверяет HMAC | `bot/index.js:285-302` `verifyTgInitData` |
| `index.js` USER_ENTERED formula injection | Google Sheets удалён | grep `USER_ENTERED`/`googleapis` → not found |
| два расходящихся index.html | мёртвого корневого нет | `ls index.html` → отсутствует |

Вывод: блок `critical_checks` (CRIT-001..007) в `audit.config.yml` — **исторический**.
Текущий статус всех семи = **RESOLVED**. Оставлен как регрессионный чеклист.

---

## 🔴 РЕАЛЬНЫЕ находки (есть в живом коде)

### VAL-BOT-01 · initData без проверки `auth_date` (freshness) — MEDIUM
- **CWE-613**, OWASP A07:2021.
- `bot/index.js:285-302` `verifyTgInitData` корректно проверяет HMAC, но **не проверяет `auth_date`**. Перехваченный initData валиден бессрочно (replay).
- **Fix:** отклонять `Date.now()/1000 - auth_date > 86400`.

### VAL-BOT-02 · Неверифицированный fallback на `telegramId` → спуфинг получателя — MEDIUM
- `bot/index.js:338` — если HMAC initData отсутствует, `resolveClientId` берёт `body.telegramId` **как есть**.
- `bot/index.js:426` — этот `clientId` идёт в `chat_id` для `sendMessage`.
- Итог: клиент может подставить чужой `telegramId` и спровоцировать отправку «заказ оформлен» на произвольный Telegram-ID (спам/фишинг от имени бота).
- **Fix:** при включённом боте принимать клиента **только** из верифицированного initData; убрать доверие к `body.telegramId`.

### VAL-BOT-03 · CSP отключён + XSS-поверхность в Mini App — MEDIUM
- `bot/index.js:16` `contentSecurityPolicy: false` и в `bot/index.html` **нет** CSP-меты (grep → not found).
- `bot/index.html` активно использует `innerHTML` с данными товара: `:2155`, `:2496` (вставка в `onerror`-атрибут), `:2066`, `:2133` и др.
- Данные товара админ-контролируемые (из CRM), поэтому риск средний, но при компрометации CRM/БД → хранимый XSS в WebView.
- **Fix:** добавить CSP-мету (`script-src 'self' https://telegram.org`); заменить `innerHTML` на `textContent`/безопасную сборку DOM там, где вставляется пользовательский/товарный текст.

### VAL-BOT-04 · Сравнение секретов не constant-time — LOW
- `bot/index.js:625` `token !== WEBHOOK_SECRET`, `:688` `provided !== secret`, `:788` `secret !== WEBHOOK_SECRET`.
- Теоретический timing-side-channel при подборе секрета.
- **Fix:** `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` с предварительной проверкой длины.

### VAL-BOT-05 · CORS fallback на `*` при пустом Origin — LOW
- `bot/index.js:35` `res.header('Access-Control-Allow-Origin', origin || '*')`.
- При пустом Origin отдаётся `*`. Credentials не используются, поэтому риск низкий, но это ослабление политики.
- **Fix:** не выставлять заголовок вовсе, если origin пустой и не в whitelist.

### VAL-BOT-06 · Несогласованность секретов admin-API — LOW
- `/api/order/done` (`:685`) защищён `config.ADMIN_SECRET`, а `/api/admin/checkin` (`:788`) — `WEBHOOK_SECRET`. Разные секреты для админ-действий усложняют ротацию и аудит.
- **Fix:** унифицировать (один `ADMIN_SECRET` для всех админских endpoint'ов).

---

## Сводка статусов

| Категория | Кол-во |
|---|---|
| RESOLVED (стало неактуально) | 7 |
| REAL · MEDIUM | 3 |
| REAL · LOW | 3 |

**Приоритет исправления:** VAL-BOT-02 (спуфинг получателя) → VAL-BOT-01 (replay initData) → VAL-BOT-03 (CSP/XSS) → остальное.
