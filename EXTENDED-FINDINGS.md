# РАСШИРЕННЫЕ НАХОДКИ (вне security-фокуса)

> Дополнение к security-отчёту: категории UI/UX (доступность), Данные/Качество, Деплой, Архитектура.
> Это «остаточные VALID» из сверки `RECONCILIATION-280.md`, подтверждённые на текущем коде.
> Severity здесь — по влиянию на качество/поддерживаемость/доступность, не на эксплуатируемость.

## CRM — Доступность (A11Y) · подтверждено grep'ом (0 aria во всём App.tsx)
| ID | Sev | Находка | Файл:строка |
|---|---|---|---|
|EXT-A11Y-1|MEDIUM|Ни одного `aria-label`/`role`/`aria-modal`/фокус-ловушки во всём интерфейсе (7917 строк)|`src/App.tsx` (0 совпадений)|
|EXT-A11Y-2|MEDIUM|Модалки без `role="dialog"`, `aria-modal`, закрытия по Esc, фокус-ловушки|`src/App.tsx:342,1122,…`|
|EXT-A11Y-3|LOW|Кликабельные `motion.div` (карточки/выбор роли) без `role="button"`/`tabIndex`/клавиатуры|`src/App.tsx:263,7416`|
|EXT-A11Y-4|LOW|`lang="en"` при русском UI; `user-scalable=no` (нарушает WCAG 1.4.4)|`index.html:2,5`|
|EXT-A11Y-5|LOW|`VoiceInput`/иконочные кнопки без `aria-label` — скринридер озвучивает пустую кнопку|`src/App.tsx:206`|

## Бот Mini App — Доступность · подтверждено grep'ом (0 aria в index.html)
| ID | Sev | Находка | Файл:строка |
|---|---|---|---|
|EXT-A11Y-6|MEDIUM|Нет `aria-label`/`role="tablist"`/`aria-live` — категории, корзина, toast недоступны для AT|`bot/index.html` (0 совпадений)|

## CRM — Данные / Качество
| ID | Sev | Находка | Файл:строка |
|---|---|---|---|
|EXT-Q-1|LOW|`Order.status: string` вместо union — компилятор не ловит несуществующий статус|`src/types.ts:28`|
|EXT-Q-2|LOW|`chartData?: any[]` — скрывает несоответствия данных графиков|`src/types.ts:120`|
|EXT-Q-3|LOW|`Math.random()` (11×) — часть в графиках/ключах → «прыгающие» данные и нестабильные React-key|`src/App.tsx` (11 вхождений)|
|EXT-Q-4|LOW|Фейковые метрики: `newCustomers = todayOrders*0.25`, `retentionStats.avgTime=2.4` (хардкод)|`src/App.tsx:1497,2175`|
|EXT-Q-5|LOW|Хардкод-данные в проде: `INITIAL_STAFF`, `INITIAL_SHIFT_REPORTS`, маркетинг «Уровень 12 / топ-3%»|`src/App.tsx:659-668`|
|EXT-Q-6|LOW|`monthlyAggregated` sort всегда `return 0` — порядок месяцев не гарантирован|`src/App.tsx:1104`|
|EXT-Q-7|LOW|`confirm()` для удаления — заблокирован в Telegram WebApp, удаление молча не срабатывает|`src/App.tsx:2033`|
|EXT-Q-8|LOW|Автосумма оффлайн-продажи перезаписывает ручной ввод суммы|`src/App.tsx:985`|
|EXT-Q-9|LOW|`DAILY_STATS` placeholder-fallback; дубль 7 (server) vs 13 (constants) слотов|`src/constants.ts` · `server.ts:118`|

## CRM — Деплой / Сборка
| ID | Sev | Находка | Файл:строка |
|---|---|---|---|
|EXT-D-1|LOW|`vite` одновременно в `dependencies` и `devDependencies` — двойная установка|`package.json:43,54`|
|EXT-D-2|LOW|`@tailwindcss/vite`, `@vitejs/plugin-react`, `shadcn` CLI в runtime `dependencies`|`package.json`|
|EXT-D-3|LOW|`allowJs:true` без `checkJs` — JS-хелперы не проверяются типами|`tsconfig.json`|
|EXT-D-4|LOW|`.env.example` неполный (часть переменных сервера не задокументирована)|`.env.example`|

## CRM — Архитектура
| ID | Sev | Находка | Файл:строка |
|---|---|---|---|
|EXT-ARCH-1|MEDIUM|God Component — `App.tsx` **7917 строк**: весь стейт/логика/UI в одном файле|`src/App.tsx`|
|EXT-ARCH-2|MEDIUM|Нет ни одного теста (unit/integration/E2E) в обоих репо|—|
|EXT-ARCH-3|LOW|Cron в web-процессе — при нескольких инстансах Railway Happy Hour уйдёт многократно|`server.ts:1146`|
|EXT-ARCH-4|LOW|«Вчера» считается по локальной дате браузера, сервер/cron — Minsk (UTC+3) → расхождение у полуночи|`src/App.tsx` · `server.ts`|
|EXT-ARCH-5|LOW|`getElementById('root')!` — небезопасный non-null assertion без диагностики|`src/main.tsx:27`|
|EXT-ARCH-6|LOW|Нет общих типов/контрактов между сервером и клиентом (DTO дублируются вручную)|`types.ts` · `server.ts`|

## Бот — Качество / Надёжность / Деплой
| ID | Sev | Находка | Файл:строка |
|---|---|---|---|
|EXT-B-1|LOW|`express.json/text` лимит 10mb на публичных эндпоинтах — Memory-DoS большими телами|`bot/index.js:20-21`|
|EXT-B-2|LOW|Markdown-сообщения с `parse_mode:'Markdown'` — пользовательский текст (имя/отзыв) без экранирования спецсимволов|`bot/index.js:578,…`|
|EXT-B-3|LOW|`cbSeen` (дедуп callback) только в памяти — после рестарта повторный callback обработается снова|`bot/index.js:50`|
|EXT-B-4|LOW|`node-fetch@2.7.0` лишний — в Node 18+ есть нативный `fetch`|`package.json:16`|
|EXT-B-5|LOW|Захардкоженный UTC+3 (Minsk) в нескольких местах — сломается при DST/переносе|`bot/index.js:316,773,830`|
|EXT-B-6|LOW|`app.listen` стартует до `initDB()`/`setWebhook()` — трафик может прийти до готовности|`bot/index.js:883`|
|EXT-B-7|LOW|Монолит `bot/index.js` (888 строк): HTTP + Telegram + БД + cron в одном файле|`bot/index.js`|

---

## Итог расширения
Добавлено **27** подтверждённых находок вне security-фокуса (1 категория — доступность — особенно показательна: **0 aria-атрибутов** в обоих фронтендах). Все — LOW/MEDIUM по качеству/доступности, не эксплуатируемые уязвимости.

**Общий объём актуального (security + extended):** 24 security + 27 extended = **51 подтверждённая находка по текущему коду** — против 280 в майском аудите (две трети которого закрыты переписью проекта или устарели). Это и есть честная «полная» картина: широкий охват, но без раздувания дублями и мёртвыми ссылками.
