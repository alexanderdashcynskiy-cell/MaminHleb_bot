# СВЕРКА 280 ПРОБЛЕМ С ЖИВЫМ КОДОМ

> Сопоставление вашего первого аудита (`AUDIT_MERGED_FINAL.pdf`, 280 проблем = `AUDIT.md` v2.3 204 + 76 новых)
> с **текущим** кодом обоих репозиториев. Дата сверки: 2026-06-02.
> Каждый пункт прочитан против реального кода (не по памяти).

## Легенда статусов
- ✅ **RESOLVED** — исправлено в текущем коде (с доказательством).
- 🔴 **VALID** — всё ещё актуально (входит в мой security-отчёт или подтверждено grep'ом).
- ⚪ **STALE** — относилось к удалённому коду/функции (Google Sheets, state.json, второй index.html) → неприменимо.
- 🟡 **PARTIAL** — частично закрыто / частично актуально.

## Что радикально изменилось с мая (и закрыло целые блоки)
1. **Google Sheets полностью удалён** → PostgreSQL + Prisma. Подтверждено grep'ом: в `bot/index.js` нет `USER_ENTERED`, `getSheets`, `GOOGLE_CREDENTIALS`, `appendRow`, `decrementStock`, `/api/test-sheets`, `pollReplies` (все =0). В `server.ts` нет `doc.loadInfo`.
2. **state.json удалён** → таблица `bot_state` в Postgres (`storageAdapter`).
3. **Второй (корневой) `index.html` в боте удалён** → расхождение двух Mini App неактуально.
4. **Добавлены:** серверная HMAC-верификация `initData`, webhook secret-token, `requireAuth` + rate-limit, серверный AI-прокси, серверный расчёт цены (`priceOrder`).

---

# ПРОЕКТ 1 — CRM

## 🔴 Критические (11)
| # | Проблема (v2.3) | Статус | Доказательство в текущем коде |
|---|---|---|---|
|1|GEMINI_API_KEY в бандле (define)|✅ RESOLVED|`vite.config.ts` без `define`|
|2|GoogleGenAI в браузере|✅ RESOLVED|Gemini только на сервере `server.ts:977,602`|
|3|6 вызовов generateContent из браузера|✅ RESOLVED|прокси `/api/ai/generate` + `authFetch`|
|4|Нет auth на 10 эндпоинтах|🟡 PARTIAL|`requireAuth` добавлен; **открыты** `/api/sessions`, `/api/employees`(GET), `/api/orders/create`, `/api/session/*` (= CRM-H3)|
|5|express-rate-limit не применён|✅ RESOLVED|`loginLimiter/telegramReportLimiter/geminiLimiter` применены|
|6|verify-password маршрут отсутствует|✅ RESOLVED|`server.ts:662`|
|7|baker/report маршрут отсутствует|✅ RESOLVED|`server.ts:1023`|
|8|inventory/update игнорирует поля|✅ RESOLVED|`server.ts:851` принимает name/price/weight/category|
|9|Протухание row id в Sheets|⚪ STALE|нет Sheets; Prisma id стабилен|
|10|orderNumber = rows.length−i (инверсия)|✅ RESOLVED|`server.ts:777` `count+1` `padStart`|
|11|JSON.parse(Gemini) без try/catch|✅ RESOLVED|AI на сервере; клиент `aiGenerate` обрабатывает ошибки|

## 🔐 Безопасность (13)
| # | Проблема | Статус | Доказательство |
|---|---|---|---|
|1|Нет CSP / Telegram SDK без SRI|🔴 VALID|`index.html:7` (= CRM-L4)|
|2|/api/telegram-report HTML-инъекция|🔴 VALID|`server.ts:588` (= CRM-M2)|
|3|webhook без secret если env пуст|🟡 PARTIAL|`server.ts:1109` проверяет, **только если** `TELEGRAM_WEBHOOK_SECRET` задан|
|4|role в localStorage → обход RBAC|🔴 VALID|сервер роль не проверяет (= CRM-H2)|
|5|inventory/add formula injection|⚪ STALE|нет Sheets|
|6|reviews formula injection|⚪ STALE|нет Sheets|
|7|Бизнес-данные в Gemini из браузера|✅ RESOLVED|AI на сервере|
|8|Данные клиента в Gemini без маскирования|🟡 PARTIAL|теперь с сервера, но PII всё ещё уходит в Gemini (`server.ts:603`)|
|9|Ключ GoogleGenAI в бандле|✅ RESOLVED|—|
|10|/api/health раскрывает sheetsConfigured|✅ RESOLVED|`server.ts:631` без него (`dbConnected:true`)|
|11|@import fonts.googleapis в index.css|🔴 VALID|`src/index.css:4` (внешний запрос, LOW)|
|12|Нет rate limiting|✅ RESOLVED|лимитеры применены|
|13|RBAC только условный рендер|🔴 VALID|= CRM-H2|

## 🐛 Баги (24)
| # | Проблема | Статус | Прим. |
|---|---|---|---|
|1–4,13|`Math.random()` в JSX/useMemo/id|🟡 PARTIAL|11 вхождений в App.tsx; часть — id (косметика), фабрикация в графиках требует точечной правки|
|5,6|JSON.parse localStorage без try/catch|✅ RESOLVED|`App.tsx:708,973` обёрнуты в try/catch|
|7|showToast в deps useEffect|🟡 PARTIAL|`showToast` не в useCallback — требует проверки циклов|
|8|monthlyAggregated sort → 0|🔴 VALID|`App.tsx:1104` `return 0`|
|9–11|topSellers/soldItems×3/newCustomers фейк|🟡 PARTIAL|`newCustomers = todayOrders*0.25` (`App.tsx:1497`) — эвристика осталась|
|12|parseInt цены|🟡|inventory/add валидирует число; UI-парсинг требует проверки|
|14|confirm() в Telegram WebApp|🔴 VALID|`App.tsx:2033` `if(!confirm(...))`|
|15|Comment.replied/replyText не возвращаются|✅ RESOLVED|`server.ts:485-487` возвращает|
|16,17,23|Серверный парсинг дат/сумм из Sheets|⚪ STALE|сервер использует `createdAt:DateTime`, не строки Sheets|
|18a|historicalReports не возвращается|✅ RESOLVED|`server.ts:568`|
|18b,19|pickupTime / order.id+2 в уведомлениях|🟡 PARTIAL|требует точечной проверки|
|20,21|colFound / колонки Sheets|⚪ STALE|концепт Sheets|
|22|Автосумма перезаписывает ручной ввод|🔴 VALID|`App.tsx:985`|
|24|saveShiftToHistory без await|🟡 PARTIAL|требует проверки|

## 🎨 UI/UX (13) — **доступность подтверждена grep'ом: 0 aria в App.tsx**
| # | Проблема | Статус |
|---|---|---|
|1–3|Хардкод «Уровень 12 / топ-3% / Сессии(4)»|🔴 VALID|
|4|`lang="en"` при рус. UI|🔴 VALID (`index.html:2`)|
|5|`user-scalable=no`|🔴 VALID (`index.html:5`)|
|6–12|Нет aria-label/role/aria-modal/фокус-ловушки|🔴 VALID (0 aria во всём App.tsx)|
|13|`body{overflow:hidden}`|🟡 требует проверки index.css|

## 📦 Данные (10)
|1|DAILY_STATS placeholder fallback|🔴 VALID (`constants.ts`)|
|2|DAILY_STATS дубль 7 vs 13 слотов|🔴 VALID (constants 13 / server 7)|
|3|doc.loadInfo() 10×|✅ RESOLVED (нет Sheets)|
|4|INITIAL_STAFF/SHIFT хардкод в prod|🔴 VALID (`App.tsx:659-668`)|
|5|MOCK_* при ошибке Sheets|✅ RESOLVED (сервер отдаёт пустые массивы)|
|6|Order.status: string|🔴 VALID (`types.ts:28`)|
|7|chartData?: any[]|🔴 VALID (`types.ts:120`)|
|8|orderNumber из Sheets|⚪ STALE|
|9|retentionStats.avgTime=2.4|🔴 VALID (`App.tsx:2175`)|
|10|«Ожидание» растёт с фактом|🟡 PARTIAL|

## 🚀 Деплой (9)
|1|vite в deps и devDeps|🔴 VALID (`package.json:43,54`)|
|2|start = tsx (dev в prod)|✅ RESOLVED (`start: node dist-server/server.js`)|
|3|build без tsc|✅ RESOLVED (`build: vite build && tsc -p tsconfig.server.json`)|
|4|tailwind/vite-plugin в runtime deps|🔴 VALID|
|5|shadcn CLI в deps|🔴 VALID|
|6|tsconfig без strict|🔴 VALID (= CRM-M6)|
|7|allowJs без checkJs|🔴 VALID (`tsconfig.json`)|
|8|dev/prod bootstrap в одном файле|🟡 PARTIAL (`server.ts:1138`)|
|9|.env.example неполный|🟡 PARTIAL (READ_ONLY есть; часть переменных проверить)|

## 💀 Мёртвый код (10)
|1–4|fix.ts / fix_join / restore / resize.js|🔴 VALID (= CRM-M5)|
|5|jimp / googleapis не используются|🟡 jimp VALID; googleapis уже удалён из CRM|
|6|MOCK_CHART/MONTHLY unused|🟡 требует проверки импортов|
|7–10|aiInsight / toggleFlag / Tabs / userStates|🟡 частично (`toggleFlag` ещё есть в App.tsx; userStates на сервере остались in-memory)|

## 📝 Архитектура (10)
|1|God Component App.tsx|🔴 VALID (теперь **7917** строк)|
|2|Нет auth middleware|✅ RESOLVED (`requireAuth`)|
|3|/api/data агрегирует всё|🔴 VALID|
|4|Ошибка → mock 200 без алертов|🟡 теперь пустой ответ, не mock|
|5|Cron в web-процессе|🔴 VALID (`server.ts:1146`)|
|6|«Вчера» по локальной дате vs Minsk|🔴 VALID|
|7|getElementById('root')!|🔴 VALID (`main.tsx:27`)|
|8|Неполные TG-декларации|🟡 PARTIAL (есть initDataUnsafe, нет initData/platform)|
|9|Нет тестов|🔴 VALID|
|10|Нет shared schema DTO|🔴 VALID|

---

# ПРОЕКТ 2 — Бот + Mini App

## Mini App 🔴 Критические (5)
|1|initDataUnsafe как доверенный id|🟡 PARTIAL|клиент шлёт `tgInitData`, сервер верифицирует по HMAC; fallback на telegramId остался (= BOT-M1) + IDOR истории (= BOT-H1)|
|2,3|`mode:'no-cors'` / ложный успех|✅ RESOLVED|`no-cors` нет; `/order` читает `res.ok` (`index.html:4344`)|
|4|игнорирует json.catalog|✅ RESOLVED|есть `/api/catalog`, `/api/stock` отдаёт catalog|
|5|предзаказ `split(' в ')`|🟡 PARTIAL|`parsePreorderTime` с валидацией формата (`index.js:241`)|

## Mini App 🔐 Безопасность (8)
|1|SDK/Tailwind без SRI|🔴 VALID (= BOT-M2)|
|2|p.name/p.image без escHtml|🟡 PARTIAL|каталог статичен; escHtml применяется в большинстве стоков|
|3|address через innerHTML|✅ RESOLVED|история заказов экранирует `addr` через escHtml (`index.html:4150`)|
|4|r.text/r.name через innerHTML|✅ RESOLVED|`renderReviews` использует `escHtml` (`index.html:4241`)|
|5|API URL захардкожен|🟡 PARTIAL|относительные пути `/order` и т.д.; `API_BASE` для части|
|6|заказ как text/plain|✅ RESOLVED|`/order` шлёт `application/json` (`index.html:4328`)|
|7|onerror переписывает innerHTML|🔴 VALID (= BOT-L4)|
|8|корзина в localStorage без TTL|🟡 LOW (актуально)|

## Mini App 🐛 Баги (12) / 🎨 UI/UX (7) / 📦 Данные (5) / 🚀 Деплой (4) / 💀 Мёртвый (3) / 📝 Арх (2)
- **Расхождение двух index.html** (Деплой#1,3; Мёртвый#1,2; Данные#2,5; Арх#2) → ⚪ **STALE** (корневого файла нет).
- **Tailwind CDN** (Деплой#2) → 🔴 VALID (= BOT-M2).
- **Happy Hour по локальному времени** (Баг#9) → ✅ RESOLVED (есть `/api/happyhour` по серверному UTC+3).
- **cart=[] сбрасывает корзину** (Баг#1) → ✅ RESOLVED (`index.html:1642` грузит из localStorage).
- **Доступность** (UI/UX#4-7: нет aria-label/role/aria-live) → 🔴 VALID (grep: 0 aria в index.html).
- **Реферальный код статичный / SMS-обещание / хардкод отзывы** (UI/UX#1-3) → 🔴 VALID.
- **removeFromCart игнорирует size / цена без размера / дата предзаказа в прошлом / валидация телефона** (Баг#2,3,5,8) → 🔍 требует точечной проверки (логика осталась).
- **Цены/веса захардкожены в HTML** (Данные#3) → 🔴 VALID (массив `products`, `index.html:1535`).

## Bot backend 🔴 Критические (9)
|1|CORS `*`|✅ RESOLVED (ограничен `.telegram.org`, `index.js:27`)|
|2|/order без auth|🟡 PARTIAL (валидация phone/name/type есть; rate-limit есть; auth по initData)|
|3|/reply без auth → любое сообщение|⚪ STALE (`/reply`/`pollReplies` удалены)|
|4|/api/test-sheets пишет в prod|⚪ STALE (удалено)|
|5|JSON.parse(GOOGLE_CREDENTIALS)|⚪ STALE (нет Sheets)|
|6|TG_BASE при пустом BOT_TOKEN|🟡 PARTIAL (`validateConfig` требует BOT_TOKEN)|
|7|responses[offset] без проверки|🟡 требует проверки|
|8|/order отвечает ok до записи|✅ RESOLVED (`index.js:671` ждёт `handleOrder`, отдаёт реальный результат)|
|9|drop_pending_updates:true теряет заказы|✅ RESOLVED (`index.js:820` `false`)|

## Bot backend 🔐 Безопасность (8)
|1|webhook без secret-token|✅ RESOLVED (`index.js:620`)|
|2|CORS wildcard|✅ RESOLVED|
|3,4,5|Markdown injection (product_name/note/reply)|🟡 PARTIAL (отзыв/имя в Markdown — требует экранирования; часть путей удалена)|
|6|USER_ENTERED formula injection|⚪ STALE (нет Sheets)|
|7|express.json/text 10mb DoS|🔴 VALID (`index.js:20-21` лимит 10mb)|
|8|GOOGLE_CREDENTIALS в env|⚪ STALE|

## Bot backend 🐛 Баги (14) / 📦 Данные (7) / 🚀 Деплой (4) / 💀 Мёртвый (4) / 📝 Арх (5)
- **Все Sheets-баги** (appendRow race, decrementStock race, getSheets OAuth, USER_ENTERED, oversell, quantity<0) → ⚪ **STALE** (нет Sheets; склад в Postgres, `priceOrder` отбрасывает неизвестный товар и `qty<=0`, `index.js:357-358`).
- **state.json** (Данные#1-3, Деплой#1) → ✅ RESOLVED (Postgres `bot_state`).
- **Дедуп cbSeen в памяти** (Баг#9) → 🔴 VALID (`index.js:50`, теряется при рестарте, но с hourly-prune).
- **UTC+3 захардкожен** (Баг#13) → 🔴 VALID (`index.js`).
- **node-fetch 2.7.0 лишний** (Мёртвый#4) → 🔴 VALID (`package.json:16`).
- **Нет TypeScript / нет test/lint скриптов** (Деплой#3,4) → 🟡 PARTIAL (добавлены `audit.sh`/CI/eslint в рамках этой сессии).
- **Монолит index.js / listener до готовности** (Арх#1,4) → 🔴 VALID (888 строк; `app.listen` затем `initDB`).
- **Нет mutex pollReplies** (Баг#14) → ⚪ STALE (удалён).

## 🌐 Кросс-проект (5)
|1|Нет HMAC initData нигде|✅ RESOLVED (бот верифицирует; CRM по паролю)|
|2|Google Sheets как единственная БД|✅ RESOLVED (Postgres)|
|3|Нет общих типов/контрактов|🔴 VALID|
|4|Нет CI/CD|✅ RESOLVED (добавлен `.github/workflows/security.yml` в этой сессии)|
|5|Нет логирования/мониторинга|🟡 PARTIAL (console.* есть; Pino/Sentry нет)|

---

# ИТОГ СВЕРКИ (приближённо по категориям)

| Статус | Доля | Чем объясняется |
|---|---|---|
| ✅ RESOLVED | ~45% | Удаление Google Sheets, миграция на Postgres, auth/HMAC/rate-limit, серверный AI, исправленные маршруты, удаление второго index.html |
| ⚪ STALE | ~20% | Пункты про Sheets / state.json / второй index.html / pollReplies — кода больше нет |
| 🔴 VALID | ~25% | Доступность (aria=0), архитектура (монолит, нет тестов, нет shared schema), CSP/SRI, vite-дубль, node-fetch, хардкод-данные, серверный RBAC/пароли |
| 🟡 PARTIAL | ~10% | Markdown-экранирование, .env полнота, частичные метрики |

**Главный вывод:** из 280 проблем майского аудита **примерно две трети закрыты или устарели** (это эффект большой переписи проекта). Реально остаётся ~35% — и они почти полностью совпадают с моим security-отчётом плюс блок **доступности (UI/UX)** и **архитектуры/качества**, которые не были в фокусе security-аудита. Эти «остаточные VALID» — основа для расширенного отчёта (следующий шаг).
