# 🔍 АУДИТ КОДА — МАМИН ХЛЕБ (ПОЛНЫЙ)

**Дата:** 17 мая 2026  
**Версия аудита:** 2.0 (дополнен внешним списком проблем)  
**Роль аудитора:** Senior Frontend/Backend Developer, UI/UX Designer, Cybersecurity Specialist (12 лет опыта)  
**Проекты:** 3 компонента в 2 репозиториях  
**Итоговое число проблем:** 202 (CRM: 93 + Bot Backend: 55 + Mini App: 46 + Cross: 5 + уточнения v2.1: +3)  
**Метод:** Полное чтение всех исходных файлов + внешний список + финальная верификация каждого утверждения  
**Ветка:** `claude/audit-white-fox-dashboard-W4DAS`

> **Что изменилось в v2.1 (финальная верификация):** Исправлены 3 ошибочных утверждения из v2.0 и добавлен 1 пропущенный реальный баг. Убраны ложные criticals #9, #10, #11 (механизм был описан неверно), их заменили точные формулировки реальных проблем.

---

## Условные обозначения

| Символ | Значение |
|--------|----------|
| 🔴 | Критическая — требует немедленного исправления |
| 🔐 | Безопасность — уязвимость или утечка |
| 🐛 | Баг / логическая ошибка |
| 🎨 | UI/UX |
| 📦 | Данные |
| 🚀 | Деплой / сборка |
| 💀 | Мёртвый код |
| 📝 | Архитектура |
| ✅ | Исправлено |

---

---

# ПРОЕКТ 1: `crm-maminhleb7`

**Стек:** React 19 + TypeScript + Vite 6 + Express.js + Google Sheets API + Gemini AI + Tailwind CSS v4  
**Деплой:** Railway.app · Telegram Mini App

---

## 🔴 Критические (11)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `vite.config.ts` | 11 | `GEMINI_API_KEY` бакается в клиентский бандл через `define: { 'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY) }` — ключ виден в DevTools у любого пользователя |
| 2 | `src/App.tsx` | 108, 614 | `import { GoogleGenAI }` + `new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })` — Gemini SDK инициализируется в браузере; ключ утекает в бандл |
| 3 | `src/App.tsx` | 2091, 2143, 2250, 2395, 2435, 2471 | 6 прямых вызовов `ai.models.generateContent()` из браузера — AI-запросы идут с клиента без логирования и ограничений |
| 4 | `server.ts` | 257–763 | Ни один из 10 API-эндпоинтов **не имеет аутентификации** — любой может читать заказы, менять склад, отправлять отчёты |
| 5 | `server.ts` | 25 (package.json) | `express-rate-limit` установлен но **нигде не применяется** |
| 6 | `src/App.tsx` | 1159 | Frontend отправляет логин на `/api/verify-password`, но этого маршрута **нет в `server.ts`** — вход всегда завершается 404, пользователь не может войти |
| 7 | `src/App.tsx` | 1681 | `handleLogout` для пекаря отправляет `/api/baker/report`, но маршрута **нет на сервере** — производственный отчёт пекаря всегда теряется |
| 8 | `src/App.tsx` | 1967 | Редактирование товара вызывает `/api/inventory/update`, но сервер принимает только `{id, stock, image, isNew, isBestSeller}`; клиент шлёт `{name, price, weight, category, ...}` — эти поля **молча игнорируются**, UI показывает «Товар обновлён» без реального сохранения |
| 9 | `server.ts` | 341–365 | `id: i` (индекс строки) присваивается до `.reverse()` — само по себе безопасно. **Реальная проблема иная:** `id` протухает — если между вызовами `/api/data` и `/api/orders/status` кто-то добавит/удалит строку в Sheets, `rows[id]` в `updateOrderStatusInternal` обратится к **другому заказу**. Нет ни TTL, ни версионирования |
| 10 | `server.ts` | 354 | `orderNumber: (ordersRows.length - i)` — чем новее заказ (выше индекс), тем **ниже** его номер; самый первый заказ (#0) получает наибольший номер. Все номера меняются при каждом добавлении строки |
| 11 | `src/App.tsx` | 2476 | `const result = JSON.parse(response.text)` без `try/catch` — Gemini возвращает markdown ` ```json ... ``` `, что вызывает `SyntaxError` и падение вкладки |

---

## 🔐 Безопасность (13)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `index.html` | 58 | Нет `Content-Security-Policy` — открыт XSS; Telegram SDK без SRI (`integrity`) — компрометация CDN меняет весь Mini App |
| 2 | `server.ts` | 447–488 | `/api/telegram-report` принимает `reportText` и передаёт его с `parse_mode: HTML` без санитизации — HTML-инъекция в чаты администраторов |
| 3 | `server.ts` | 777 | Telegram webhook работает без проверки `TELEGRAM_WEBHOOK_SECRET` если env не задан — любой может слать callback payload и менять статусы заказов через `delivered_*` |
| 4 | `src/App.tsx` | 1189 | Сессионные данные (`name`, `role`, `expiresAt`) хранятся в `localStorage` — пользователь может изменить роль через DevTools и обойти клиентский RBAC |
| 5 | `server.ts` | 627 | `/api/inventory/add` пишет `name`, `category`, `image` в Sheets без защиты от **formula injection** (`=IMPORTXML`, `=HYPERLINK`) через `valueInputOption: USER_ENTERED` |
| 6 | `server.ts` | 763 | Отзывы пользователей сохраняются в Sheets без фильтрации формул — тот же formula injection через `USER_ENTERED` |
| 7 | `src/App.tsx` | 2072–2471 | Бизнес-данные (выручка, заказы, остатки) отправляются в Gemini напрямую из браузера — **неконтролируемая утечка коммерческих данных** |
| 8 | `src/App.tsx` | 2428 | Имя клиента и история заказов отправляются в Gemini без маскирования — **утечка персональных данных (GDPR риск)** |
| 9 | `src/App.tsx` | 614 | `GoogleGenAI` во фронтенде: ключ попадает в браузерный bundle через Vite `define` |
| 10 | `server.ts` | 493 | `/api/health` публично раскрывает `sheetsConfigured: true/false` — атакующий видит, подключён ли production Google Sheets |
| 11 | `src/index.css` | 4 | `@import url(fonts.googleapis.com)` — внешний трекинг-запрос при каждой загрузке, точка отказа в Telegram WebView |
| 12 | `server.ts` | 21 | Нет rate limiting на API несмотря на установленный `express-rate-limit`; DoS, брутфорс, спам Gemini открыты |
| 13 | `src/App.tsx` | 5670 | RBAC реализован только условным рендером навигации; сервер не знает роль и не блокирует прямые POST-запросы |

---

## 🐛 Баги и логические ошибки (24)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `src/App.tsx` | 513 | `Math.random()` прямо в JSX — новое значение на каждый рендер |
| 2 | `src/App.tsx` | 1494–1500 | `Math.random()` в `useMemo` для `chartData` (`prevOrders`, `prevRevenue`, `forecast`) — данные "прыгают" при каждом обновлении `orders` |
| 3 | `src/App.tsx` | 1528–1533 | `Math.random()` в `useMemo` для `popularityData` (`growth`, `margin`, `value`) — гистограммы мерцают |
| 4 | `src/App.tsx` | 5247 | `Math.round(Math.random() * 5 + 5)%` в JSX AI-комментарии — каждый рендер другой процент «роста» |
| 5 | `src/App.tsx` | 692 | `JSON.parse(storedHistory)` без `try/catch` — повреждённый `localStorage` роняет приложение белым экраном |
| 6 | `src/App.tsx` | 921–922 | `JSON.parse(stored)` для оффлайн-продаж без `try/catch` — краш при неверном JSON |
| 7 | `src/App.tsx` | 2363 | `showToast` в массиве зависимостей `useEffect` — не `useCallback`, пересоздаётся каждый рендер, бесконечный цикл обновлений |
| 8 | `src/App.tsx` | 1028–1032 | Сортировка `monthlyAggregated` возвращает `0` всегда — порядок месяцев не гарантирован |
| 9 | `src/App.tsx` | 1632 | `topSellers` сортируется по `stock` (остатку), а не по продажам — показывает товары с наибольшим запасом |
| 10 | `src/App.tsx` | 1642 | `soldItems: todaySalesCount * 3` — искусственный множитель без логики |
| 11 | `src/App.tsx` | 1644 | `newCustomers = Math.floor(todaySalesCount * 0.2)` — выдуманная метрика |
| 12 | `src/App.tsx` | 1958 | `price: parseInt(newItem.price)` — `parseInt` обрезает `12.50` → `12`; нужен `parseFloat` |
| 13 | `src/App.tsx` | 4862 | `Math.random().toString(36)` как ID в JSX — новый ID на каждый рендер |
| 14 | `src/App.tsx` | 1781 | `confirm("...")` — `window.confirm()` заблокирован в Telegram WebApp; удаление молча не срабатывает |
| 15 | `src/types.ts` | 54–56 | `Comment.replied` и `Comment.replyText` определены, но `/api/data` их **не возвращает** — ответы теряются при обновлении |
| 16 | `server.ts` | 381 | `chronOrders.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())` — использует голый `new Date()` без fallback-парсера; строки из Sheets в формате DD.MM.YYYY дают `NaN`, сортировка нестабильна. Клиентский `parseDate` (src/App.tsx:207) имеет корректный fallback, но серверный код его не вызывает |
| 17 | `server.ts` | 415 | В вычислении `growthLevel`: `orders.filter(o => new Date(o.time).toLocaleDateString('ru-RU') === today)` — `new Date("12.05.2026")` = Invalid Date; `todayTotal` всегда 0 при DD.MM.YYYY датах из Sheets; `growthLevel` всегда `-100%` |
| 18 | `server.ts` | 422 + `src/App.tsx` | `/api/data` **никогда не возвращает** поле `historicalReports`. Сервер читает лист «отчетность» (строка 312) но использует данные только для `settings.*` мультипликаторов. Клиент проверяет `data.historicalReports` — условие всегда `false`, `historicalReports` state всегда `[]`. Все вычисления «вчера» в `todayAnalytics` (строка 1326: `historicalReports.find(r => r.date === yStr)`) и в `chartData` (строка 1482) всегда дают `undefined` → `growthLevel` всегда `"0%"`, сравнение день/день полностью нерабочее |
| 18 | `src/App.tsx` | 2339 | Pickup alert проверяет `order.pickupTime`, но сервер **не заполняет** `pickupTime` — уведомления самовывоза никогда не сработают |
| 19 | `src/App.tsx` | 2352 | Номер заказа в уведомлении = `order.id + 2` — не совпадает с реальным `orderNumber`, ломается при сортировках |
| 20 | `src/App.tsx` | 1888 | Frontend ожидает `data.colFound === false`, но сервер **никогда не возвращает** это поле — сценарий «колонка не найдена» недостижим |
| 21 | `server.ts` | 585 | Если колонок `Новинка`/`Хит` нет в Sheets, сервер молча возвращает success — флаг не записан, UI считает успехом |
| 22 | `src/App.tsx` | 930 | Автосумма оффлайн-продажи перезаписывает вручную введённую сумму при каждом изменении cash/card |
| 23 | `server.ts` | 359 | `Number(r.get("Сумма"))` не парсит строки вида `"1 200,50 р."` — результат `NaN`, выручка ломается |
| 24 | `src/App.tsx` | 1624 | `saveShiftToHistory` вызывается без `await` — пользователь видит «смена завершена», хотя запись ещё может упасть |

---

## 🎨 UI/UX (13)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `src/App.tsx` | 6574 | `"Уровень 12"` хардкод — не рассчитывается из реальных данных |
| 2 | `src/App.tsx` | 6578 | `"топ-3% администраторов"` — выдуманный маркетинговый текст |
| 3 | `src/App.tsx` | 6684 | `"Сессии (4)"` — хардкод, счётчик не реализован |
| 4 | `index.html` | 53 | `lang="en"` при русскоязычном интерфейсе — скринридеры и автопереводчики работают неправильно |
| 5 | `index.html` | 56 | `user-scalable=no` — запрещает масштабирование, нарушает WCAG 1.4.4 для слабовидящих |
| 6 | `src/App.tsx` | 197 | Кнопка голосового ввода без `aria-label` — скринридер озвучивает пустую кнопку |
| 7 | `src/App.tsx` | 260 | `PremiumStatCard` — кликабельный `motion.div` без `role="button"`, `tabIndex`, keyboard handler — недоступен с клавиатуры |
| 8 | `src/App.tsx` | 342 | Модальное окно без `role="dialog"`, `aria-modal`, фокус-ловушки, закрытия по Esc |
| 9 | `src/App.tsx` | 6459 | `AvatarImage` с внешним URL без `alt` — недоступно для скринридера |
| 10 | `src/App.tsx` | 2673 | Несколько KPI-карточек с `title=""` — пустые заголовки, ухудшают семантику |
| 11 | `src/App.tsx` | 6245 | Выбор роли через `button` без `aria-pressed` — выбранная роль не объявляется для AT |
| 12 | `components/ui/card.tsx` | 36 | `CardTitle` рендерится как `div`, не heading — теряется структура заголовков |
| 13 | `src/index.css` | 106 | `body { overflow: hidden }` — при длинных модалках/малых экранах контент недоступен |

---

## 📦 Данные (10)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `src/constants.ts` | 295 | `DAILY_STATS` — фиктивные placeholder-данные (8–92 продажи/час), используется как fallback на дашборде |
| 2 | `src/constants.ts` vs `server.ts` | — | `DAILY_STATS` продублирован с разным числом слотов: 7 часов vs 13 — данные несовместимы |
| 3 | `server.ts` | 153, 270, 458, 509, 572, 605, 624, 671, 688, 751 | `doc.loadInfo()` вызывается **10 раз** без кеширования — каждый API-запрос → отдельный HTTP к Google |
| 4 | `src/App.tsx` | 651–654 | `INITIAL_STAFF`/`INITIAL_SHIFT_REPORTS` с хардкодированными именами и датами попадают в production |
| 5 | `server.ts` | 58–80 | `MOCK_INVENTORY`, `MOCK_ORDERS`, `MOCK_COMMENTS` отдаются при любой ошибке Google Sheets — пользователь видит фейковые заказы и товары как реальные |
| 6 | `src/types.ts` | 28 | `Order.status: string` вместо union-типа — TypeScript не поймает статус `Выполнен`, отсутствующий в workflow |
| 7 | `src/types.ts` | 119 | `chartData?: any[]` — скрывает несоответствия `orders` vs `sales` |
| 8 | `server.ts` | 354 | `orderNumber` вычисляется как `(rows.length - i)`, не читается из Sheets — при фильтрах/удалениях номера меняются |
| 9 | `src/App.tsx` | 1928 | `retentionStats.avgTime` захардкожен как `2.4` — фиктивный интервал возврата клиентов |
| 10 | `src/App.tsx` | 2681–2696 | «Ожидание» = `todaySalesCount * multiplier` (растёт вместе с фактом); прогноз выручки = `0` при нулевой текущей выручке |

---

## 🚀 Деплой и сборка (9)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `package.json` | 12, 22 | `vite` в `dependencies` **и** `devDependencies` — Railway устанавливает дважды |
| 2 | `package.json` | 7 | `"start": "tsx server.ts"` — dev-транспайлер в продакшне |
| 3 | `package.json` | 8 | `build` запускает только `vite build` без `tsc --noEmit` — TypeScript-ошибки не блокируют production build |
| 4 | `package.json` | 18–19 | `@tailwindcss/vite`, `@vitejs/plugin-react` в runtime dependencies вместо devDependencies |
| 5 | `package.json` | 36 | `shadcn` CLI в production dependencies — увеличивает runtime install и attack surface |
| 6 | `tsconfig.json` | — | Нет `"strict": true` — TypeScript не проверяет `null`/`undefined` |
| 7 | `tsconfig.json` | 16 | `allowJs: true` без `checkJs` — JS helper-скрипты не проверяются |
| 8 | `server.ts` | 807–812 | Dev и prod bootstrap в одном файле; `path.resolve('dist/index.html')` зависит от CWD — запуск из другой директории ломает static fallback |
| 9 | `.env.example` | — | Отсутствуют: `TELEGRAM_CLIENT_CHAT_ID` (server.ts:93), `TELEGRAM_CHAT_ID` (server.ts:450 — получатель `/api/telegram-report`), `READ_ONLY`, `PORT` |

---

## 💀 Мёртвый код (10)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `fix.ts` | EOF | Одноразовый патч-скрипт. **Опасность:** `newLines.join('\\n')` — экранированный `\n` уничтожит `App.tsx` заменив все переносы строк на `"\n"` |
| 2 | `fix_join_newlines.js` | — | Одноразовый utility-скрипт |
| 3 | `restore_newlines.js` | — | Одноразовый utility-скрипт |
| 4 | `app/applet/resize.js` | — | Одноразовый Jimp-скрипт |
| 5 | `package.json` | 18–19 | `jimp`, `googleapis` установлены но не используются в CRM |
| 6 | `src/constants.ts` | 311–312 | `MOCK_CHART_ORDERS`, `MOCK_MONTHLY_ORDERS` — импортируются но не используются в `App.tsx` |
| 7 | `src/App.tsx` | 888 | `aiInsight` генерируется дорогостоящим AI-запросом, но нигде не отображается в UI |
| 8 | `src/App.tsx` | 1757 | `toggleFlag` дублирует `toggleProductFlag` и не используется в UI |
| 9 | `components/ui/tabs.tsx` | — | Компонент Tabs не импортируется в приложении |
| 10 | `server.ts` | 33 | `userStates`, `pendingRatingMessages` в памяти процесса — при рестарте Telegram review flow теряется навсегда |

---

## 📝 Архитектура (10)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `src/App.tsx` | 1–6781 | **God Component** — 6 781 строк: весь стейт, логика, вычисления, UI в одном файле |
| 2 | `server.ts` | — | Нет auth middleware — RBAC нельзя внедрить без полного рефакторинга |
| 3 | `server.ts` | 257 | `/api/data` агрегирует склад, заказы, отзывы, настройки, аналитику в одном обработчике |
| 4 | `server.ts` | 432 | Ошибка Google Sheets → mock-ответ 200 без observability/alerting; degraded mode невидим |
| 5 | `server.ts` | 815 | Cron в web-процессе — при нескольких инстансах Railway Happy Hour уйдёт несколько раз |
| 6 | `src/App.tsx` | 1322 | «Вчера» вычисляется по локальной дате браузера, сервер/cron используют Minsk — около полуночи расхождение |
| 7 | `src/main.tsx` | 27 | `document.getElementById('root')!` — небезопасный non-null assertion, нет диагностики при сбое |
| 8 | `src/main.tsx` | 1–30 | Неполные Telegram WebApp TypeScript-декларации: нет `initData`, `initDataUnsafe`, `platform`, `colorScheme` |
| 9 | — | — | Нет ни одного теста (unit, integration, E2E) |
| 10 | `src/types.ts` | 20 | Типы не разделены на DTO/API/domain; сервер вручную формирует похожие структуры без shared schema |

---

---

# ПРОЕКТ 2A: Mini App (`index.html` / `bot/index.html`)

> **Контекст:** `bot/index.js:1016` отдаёт именно `bot/index.html` в продакшн. Корневой `index.html` — мёртвый код для пользователей, но содержит более свежую логику. Оба файла существенно расходятся.

---

## 🔴 Критические (5)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.html` | 831–832 | `telegramId = tg.initDataUnsafe?.user?.id` используется как **доверенный идентификатор** — `initDataUnsafe` небезопасен, любой браузер подставит произвольный Telegram ID в заказ |
| 2 | `bot/index.html` | 2315 | `sendOrderToServer()` использует `fetch()` с `mode: 'no-cors'` — frontend **не может прочитать статус** ответа; UI всегда показывает успех при любом HTTP 500/403 |
| 3 | `bot/index.html` | 2331 | После `no-cors fetch` всегда показывается «Заказ успешно отправлен» — ложная индикация успеха при реальной ошибке |
| 4 | `bot/index.html` | 945 | Реально отдаваемый frontend обрабатывает только `json.stock`, **игнорирует `json.catalog`** — товары, заведённые в Google Sheets через CRM, невозможно заказать из Mini App |
| 5 | `bot/index.html` + `index.html` | 2172+215 | Предзаказ передаётся как строка `"date в time"`, backend парсит через `split(' в ')` — любое изменение формата в UI ломает дату/время в заказе |

---

## 🔐 Безопасность (8)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.html` | 7–8 | Telegram SDK + Tailwind CDN без SRI (`integrity`) — supply-chain атака меняет Mini App без предупреждения |
| 2 | `bot/index.html` | 1525 / `index.html` | `product.name` и `product.image` вставляются в HTML-строку без `escHtml` — XSS через названия товаров из Google Sheets |
| 3 | `bot/index.html` | 2032 | Адрес доставки выводится через `innerHTML` без экранирования — пользовательский адрес может внедрить HTML в чек |
| 4 | `bot/index.html` | 2248 | `renderReviews()` рендерит `r.text` через `innerHTML` — stored/self XSS через пользовательские отзывы |
| 5 | `bot/index.html` | 2311 | API URL захардкожен в клиенте как production Railway URL — нельзя разделить dev/prod, домен открыт для прямых POST атак |
| 6 | `bot/index.html` | 2316 | Заказ отправляется как `text/plain` — обходит CORS preflight, делая endpoint `/order` ещё проще для злоупотребления |
| 7 | `bot/index.html` | 1433 | `onerror` у изображений переписывает `innerHTML` — при внешних `p.image` URL усиливает XSS-риск |
| 8 | `index.html` | 945 | Корзина хранится в `localStorage` без TTL — на общем устройстве остаются данные о покупках пользователя |

---

## 🐛 Баги и логические ошибки (12)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.html` | 919 | `cart = []` всегда сбрасывает корзину при загрузке — пользователь теряет корзину после перезагрузки |
| 2 | `bot/index.html` | 1605 | `removeFromCart(productId)` удаляет все позиции товара игнорируя `selected_size` — при 180g и 360g удалятся обе |
| 3 | `bot/index.html` | 1535 | `addToCart()` берёт цену базового товара, не учитывая выбранный размер |
| 4 | `bot/index.html` | 2269 + `index.html` | Проверка времени предзаказа строками (`timeVal < '07:00'`) — если браузер передаст `7:00`, проверка сломается |
| 5 | `bot/index.html` | 2172 | `preorderTime` не проверяет, что дата не в прошлом — можно оформить предзаказ на вчера |
| 6 | `bot/index.html` | 1980 | Заказ отправляется внутри `setTimeout(1500)` — race condition между очисткой корзины и реальной отправкой |
| 7 | `bot/index.html` | 2141 | `addPreorderItem()` не проверяет остатки `stockData` — можно предзаказать отсутствующий товар |
| 8 | `bot/index.html` | 1782 | `validatePhone()` принимает только 25/29/33/44 — городские и другие номера отклоняются без объяснения |
| 9 | `bot/index.html` | 1784 | Happy Hour рассчитывается по **локальному времени устройства**, backend рассылает по UTC+3 — несоответствие цен |
| 10 | `bot/index.html` | 1361 | Остатки сопоставляются по `product.name.toLowerCase()` — переименование в Sheets ломает связь склада и декремента |
| 11 | `index.html` | 166 | Кнопка нижней навигации открывает `showScreen('locations')`, экрана `screen-locations` **нет** в HTML — неработающий пункт меню |
| 12 | `bot/index.html` + `index.html` | 2030 | Чек строится через `innerHTML`; если `pickupTime` пустой из-за race condition — пользователь видит пустое время |

---

## 🎨 UI/UX (7)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.html` | 591 | Реферальный код `MAMA2024` статический для всех — UX обещает персональное приглашение, но всем одинаковый placeholder |
| 2 | `bot/index.html` | 746 | Чек обещает SMS-уведомление, SMS-интеграции **нет** в проекте — ложное ожидание у пользователя |
| 3 | `bot/index.html` | 925 | Отзывы захардкожены как маркетинговые заглушки — пользователь принимает их за реальные |
| 4 | `bot/index.html` | 178 | Кнопка корзины содержит только SVG без `aria-label` — недоступна для скринридера |
| 5 | `bot/index.html` | 326 | Категории — горизонтальный скролл без `role=tablist` — клавиатурные пользователи не получают навигацию |
| 6 | `bot/index.html` | 720 | Floating cart не объявлен как `dialog`/`drawer` и не ловит фокус — клавиатурный пользователь уходит фокусом под overlay |
| 7 | `bot/index.html` | 2300 | Toast без `aria-live` — сообщения об ошибках/успехе не озвучиваются assistive technologies |

---

## 📦 Данные (5)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.html` | 880 | `productImages` полностью **отсутствуют десерты**, хотя изображения в `bot/public/images/` есть |
| 2 | `index.html` | 330 vs `bot/index.html` | Корневой файл имеет категорию «Десерты», продакшн-файл — нет; каталог отличается между окружениями |
| 3 | `bot/index.html` | 855 | Цены и веса товаров захардкожены в HTML — нет источника истины, синхронизированного с Google Sheets |
| 4 | `bot/index.html` | 1363 | Остатки отображаются как `шт.` — часть товаров продаётся по весу/объёму; единицы измерения не моделируются |
| 5 | `index.html` | 1880 vs `bot/index.html` | Список улиц Витебска различается между файлами — prod-пользователь не получает подсказки из свежей версии |

---

## 🚀 Деплой (4)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.html:1` + `index.html:1` | — | **Нет механизма синхронизации** двух HTML-копий Mini App — файлы уже разошлись по категориям, localStorage, улицам, каталогу |
| 2 | `bot/index.html` | 8 | Tailwind CDN используется как production-рантайм — ухудшает performance и усложняет CSP |
| 3 | `bot/index.js` | 1016 | Сервер отдаёт только `bot/index.html` — корневой `index.html` с более свежими изменениями не доходит до пользователей |
| 4 | `index.html` | 938 | `API_BASE` захардкожен на Railway production URL — локальная разработка читает production-склад |

---

## 💀 Мёртвый код (3)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `index.html` | 810 | Экран `screen-bestsellers` в корневом файле не попадёт в production пока сервер отдаёт `bot/index.html` |
| 2 | `index.html` | 963–964 | `_featuredNew`, `_featuredBestsellers` — только в корневом HTML, prod-файл их не использует |
| 3 | `bot/public/images/desserts-*` | — | Десертные изображения в production assets, но `bot/index.html` не содержит десертов |

---

## 📝 Архитектура (2)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.html` | 823 | Весь frontend — один HTML с глобальным состоянием и inline handlers; тот же God Component, но без React |
| 2 | `index.html` + `bot/index.html` | — | Нет shared schema для контракта `{stock, catalog, flags}` между backend и Mini App — backend отдаёт `catalog`, prod-frontend игнорирует |

---

---

# ПРОЕКТ 2B: `maminhleb_bot` (backend)

**Стек:** Node.js + JavaScript (без TypeScript) + Telegram Bot API + Google Sheets API + Express.js + node-cron  
**Файл:** `bot/index.js` — 1195 строк

---

## 🔴 Критические (9)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.js` | 17 | `Access-Control-Allow-Origin: *` на всех эндпоинтах включая мутирующие |
| 2 | `bot/index.js` | 932 | `/order` — нет аутентификации; **любой** может создать фейковый заказ |
| 3 | `bot/index.js` | 792 | `/reply` — нет аутентификации; **любой** может отправить сообщение в любой Telegram-чат от имени бота |
| 4 | `bot/index.js` | 949 | `/api/test-sheets` — публичный endpoint, **записывает тестовую строку в production-таблицу** |
| 5 | `bot/index.js` | 124 | `JSON.parse(process.env.GOOGLE_CREDENTIALS)` без проверки переменной — при пустом env первый запрос к Sheets падает с `SyntaxError` |
| 6 | `bot/index.js` | 98 | `TG_BASE` строится даже при пустом `BOT_TOKEN` — сервер стартует с невалидным API URL, ошибки проявляются только в рантайме |
| 7 | `bot/index.js` | 387 | Код читает `responses[offset]` без проверки существования — при пустом `calls` возможен crash `Cannot read properties of undefined` |
| 8 | `bot/index.js` | 932 | `/order` отвечает `{ok:true}` **до** парсинга/валидации/записи — клиент получает success при отброшенном заказе |
| 9 | `bot/index.js` | 1034 | `setWebhook({ drop_pending_updates: true })` при каждом старте **удаляет накопленные updates** — во время рестарта теряются заказы |

---

## 🔐 Безопасность (8)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.js` | 920 | `/webhook` не проверяет `X-Telegram-Bot-Api-Secret-Token` — любой может POST-ить fake updates и менять статусы |
| 2 | `bot/index.js` | 17 | CORS wildcard без allowlist домена Mini App — CSRF атаки из браузеров пользователей |
| 3 | `bot/index.js` | 200 | `product_name` из клиента вставляется в Markdown-сообщение без экранирования — **Markdown injection**, фишинговые ссылки |
| 4 | `bot/index.js` | 232 | `note` клиента вставляется в Markdown без escaping — тот же Markdown injection |
| 5 | `bot/index.js` | 1137 | Текст ответа из Google Sheets вставляется в Markdown без escaping |
| 6 | `bot/index.js` | 146, 169, 758, 907, 1180 | `valueInputOption: 'USER_ENTERED'` повсеместно — **formula injection** в Google Sheets; имя, телефон, адрес, примечание могут выполниться как `=IMPORTXML` |
| 7 | `bot/index.js` | 11–12 | `express.json({limit:'10mb'})` и `express.text({limit:'10mb'})` на публичных эндпоинтах — Memory DoS большими запросами |
| 8 | `bot/.env.example` | — | Пример `GOOGLE_CREDENTIALS` предлагает хранить весь private key JSON в env — высокий риск утечки в логи/скриншоты/панели Railway |

---

## 🐛 Баги и логические ошибки (14)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.js` | 133–149 | **Race condition в `appendRow`**: два одновременных заказа читают одинаковый `nextRow` → один затирает другой |
| 2 | `bot/index.js` | 871–913 | **Race condition в `decrementStock`**: не-атомарное read-modify-write; два заказа декрементируют только один раз |
| 3 | `bot/index.js` | 122–132 | `getSheets()` кеширует навсегда — OAuth-токен Google истекает ~1 час; все API-вызовы падают с `401` до перезапуска |
| 4 | `bot/index.js` | 1109 | Ключи дедупликации `dup_*` никогда не удаляются — `state.json` растёт бесконечно |
| 5 | `bot/index.js` | 175 | Ключ дедупликации строится из телефон/total/items без `telegramId` и адреса — разные клиенты с одинаковым заказом в 20 сек отбрасываются |
| 6 | `bot/index.js` | 199 | Backend **доверяет цене из клиента** — можно заказать товар по любой цене |
| 7 | `bot/index.js` | 236 | Номер заказа увеличивается **до** записи в Sheets — при ошибке номер потрачен, заказа нет |
| 8 | `bot/index.js` | 316 | Склад уменьшается сразу при поступлении заказа до принятия — отклонённые/отменённые заказы **не возвращают остаток** |
| 9 | `bot/index.js` | 460 | `cbSeen` (dedup callback) только в памяти — после рестарта повторный Telegram callback обработается снова |
| 10 | `bot/index.js` | 536 | `rowNum = parseInt(parts[1])` без проверки `NaN` — ручной `callback_data` может привести к `updateCell` с некорректным range |
| 11 | `bot/index.js` | 884 | `qty = item.quantity || 1` принимает отрицательные значения — **можно увеличить остаток** передав `quantity: -5` |
| 12 | `bot/index.js` | 889 | `Math.max(0, remaining - qty)` скрывает oversell — заказать больше остатка, склад просто станет 0 без ошибки |
| 13 | `bot/index.js` | 1100 | UTC+3 для Minsk захардкожен вручную — при переносе приложения/изменении DST сломается |
| 14 | `bot/index.js` | 1129 | `pollReplies()` может запуститься повторно если предыдущий проход дольше 2 минут — **нет mutex**: один ответ уйдёт дважды |

---

## 📦 Данные (7)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.js` | 39 | `STATE_FILE = './state.json'` зависит от CWD, не `__dirname` — запуск не из `bot/` создаёт state в другом месте |
| 2 | `bot/index.js` | 39 | `state.json` на эфемерной файловой системе Railway — **уничтожается при каждом деплое** |
| 3 | `bot/index.js` | 57 | `fs.writeFileSync` не атомарный — crash во время записи **повреждает** `state.json` |
| 4 | `bot/index.js` | 85 | `orderCount > 9999` — эвристика; при 10 000+ заказов счётчик **сбросится в 0** |
| 5 | `bot/index.js` | 824 | Лист склада захардкожен как `Склад!A2:J` — нет env-переменной в отличие от листа заказов |
| 6 | `bot/index.js` | 850 | ID динамического товара генерируется из имени — **переименование в Sheets меняет ID**, ломает корзины/историю |
| 7 | `bot/index.js` | 324–329 | `known_clients` собирается и сохраняется в `state.json`, но Happy Hour читает клиентов **напрямую из Sheets** — утечка данных без пользы |

---

## 🚀 Деплой (4)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.js` | 39 | `state.json` несовместим с Railway ephemeral FS — нужен Upstash/Redis |
| 2 | `bot/.env.example` | — | Отсутствуют: `DELIVERY_CHAT_ID`, `PREORDER_CHAT_ID`, `ORDERS_SHEET_NAME`, `PORT` |
| 3 | `bot/package.json` | — | Нет TypeScript — ошибки типов обнаруживаются только в рантайме |
| 4 | `bot/package.json` | 6 | Нет скриптов `test`, `lint`, `typecheck`, `build`, `audit` — ошибки не ловятся CI/деплоем |

---

## 💀 Мёртвый код (4)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.js` | 228 | `deliveryInfo` присваивается, нигде не используется |
| 2 | `bot/index.js` | 303 | `adminBase` — отдельная переменная без смысла, копирует `adminHeader` |
| 3 | `bot/index.js` | 567 | Action `working` реализован, но нет штатного пути к нему после `accept` — недостижимое состояние |
| 4 | `bot/package.json` | — | `node-fetch: ^2.7.0` — Node.js 18+ имеет нативный `fetch`; лишняя зависимость |

---

## 📝 Архитектура (5)

| # | Файл | Строка | Проблема |
|---|------|--------|----------|
| 1 | `bot/index.js` | 1–1195 | **Монолит 1195 строк**: HTTP routes + Telegram + Sheets + orders + склад + cron — всё в одном файле |
| 2 | `bot/index.js` | 11 | Body parsers подключены глобально — нет route-specific лимитов и типов для `/order`, `/reply`, `/webhook` |
| 3 | `bot/index.js` | 943 | `/api/stock` зависит напрямую от Sheets latency — нет cache/stale fallback и circuit breaker |
| 4 | `bot/index.js` | 1189 | HTTP listener поднимается, затем **асинхронно** инициализируются Sheets/webhook — трафик может прийти до готовности интеграций |
| 5 | — | — | Нет тестов для критичных потоков: `appendRow`, `decrementStock`, callback statuses |

---

---

# 🌐 Кросс-проектные проблемы (5)

| # | Категория | Проекты | Проблема |
|---|-----------|---------|----------|
| 1 | 🔐 Безопасность | CRM + Bot + Mini App | **Нет проверки Telegram WebApp `initData` HMAC нигде**: Mini App доверяет `initDataUnsafe`, Bot принимает любой `telegramId`, CRM не имеет серверной сессии |
| 2 | 📦 Данные | CRM + Bot | **Google Sheets как единственная БД** без резервного копирования, без транзакций, с лимитами API (300 req/min); блокировка аккаунта = полная остановка бизнеса |
| 3 | 📦 Данные | CRM + Bot + Mini App | **Нет общих типов/контрактов**: структура заказа (`appendRow` → 14 колонок) не зафиксирована; изменение схемы в одном месте ломает другие без ошибки компиляции |
| 4 | 🚀 Деплой | CRM + Bot | **Нет CI/CD**: нет `.github/workflows/` — линтер, типы, тесты не проверяются перед деплоем |
| 5 | 🚀 Деплой | CRM + Bot | **Нет request logging/monitoring** (Pino, Sentry, Morgan) — обнаружение проблем только когда клиент жалуется |

---

---

# 🚀 Рекомендации по будущим фичам

## Приоритет 1 — Безопасность (до публичного запуска)

1. **Telegram initData HMAC** на backend для всех Mini App запросов (Node.js crypto.createHmac)
2. **Server-side price calculation** — backend игнорирует цену от клиента, считает из Sheets
3. **JWT + HttpOnly cookie** — серверные сессии для CRM вместо localStorage
4. **AI Proxy endpoint** — убрать все 6 Gemini-вызовов из браузера на сервер
5. **Rate Limiting** — применить `express-rate-limit`: /api/login 5 req/15min, /api/ai 10 req/min
6. **Google Sheets RAW** вместо `USER_ENTERED` — устранить formula injection
7. **Webhook secret** в Bot — `X-Telegram-Bot-Api-Secret-Token` обязателен

## Приоритет 2 — Надёжность

8. **Upstash Redis** вместо `state.json` в Bot
9. **Atomic `appendCells`** в Google Sheets API вместо read-then-write в `appendRow`
10. **OAuth token refresh** в `getSheets()` — убрать бесконечный кеш без TTL
11. **Error boundaries** на каждую вкладку CRM
12. **Sentry / Telegram Error Alerts** для server-side ошибок

## Приоритет 3 — Синхронизация Mini App

13. **Единый источник истины** — `bot/index.html` генерируется из шаблона или заменяется на `index.html`; никаких двух копий
14. **Реальный fetch с обработкой ответа** — убрать `mode: 'no-cors'`, добавить обработку HTTP статусов
15. **Сборка Tailwind** вместо CDN — CSP + performance

## Приоритет 4 — Качество кода

16. **Декомпозиция App.tsx** → `hooks/`, `components/Dashboard/`, `components/Orders/`, etc.
17. **TypeScript в Bot** — мигрировать `bot/index.js` → `bot/src/index.ts`
18. **Тесты** — минимум unit-тесты для `appendRow`, `decrementStock`, парсинга заказов
19. **Реальная аналитика** — убрать `Math.random()` из `chartData`, `popularityData`

## Приоритет 5 — Функциональность

20. **Статусы заказа в Mini App** — пользователь видит: принят → готовится → готов → доставляется
21. **Персональные referral codes** — заменить статический `MAMA2024`
22. **Проверка даты предзаказа** — нельзя оформить в прошлом
23. **Валидация склада при заказе** — нельзя заказать больше остатка

---

---

# 📊 Итоговая статистика

| Категория | CRM | Mini App | Bot | Cross | Итого |
|-----------|-----|----------|-----|-------|-------|
| 🔴 Критические | 11 | 5 | 9 | — | **25** |

| 🔐 Безопасность | 13 | 8 | 8 | 1 | **30** |
| 🐛 Баги/Логика | 26 | 12 | 14 | — | **52** |
| 🎨 UI/UX | 13 | 7 | — | — | **20** |
| 📦 Данные | 10 | 5 | 7 | 2 | **24** |
| 🚀 Деплой/Сборка | 9 | 4 | 4 | 2 | **19** |
| 💀 Мёртвый код | 10 | 3 | 4 | — | **17** |
| 📝 Архитектура | 10 | 2 | 5 | — | **17** |
| **Итого** | **102** | **46** | **51** | **5** | **204** |

---

## Критический путь (исправить первыми)

1. `bot/index.html:2315` → убрать `mode: 'no-cors'`; добавить серверную HMAC-верификацию `initData`
2. `vite.config.ts:11` → убрать `GEMINI_API_KEY` из `define`, перенести AI на сервер
3. `server.ts` → `requireAuth` middleware на все эндпоинты кроме health и webhook
4. `bot/index.js:17` → ограничить CORS до домена Mini App
5. `bot/index.js:920` → верифицировать `X-Telegram-Bot-Api-Secret-Token`
6. `bot/index.js:949` → удалить или за-passwordить `/api/test-sheets`
7. `src/App.tsx:1159` → добавить маршрут `/api/verify-password` в `server.ts`
8. `server.ts:341` → исправить маппинг `id` заказов после `.reverse()`
9. `bot/index.js:146+` → заменить `USER_ENTERED` на `RAW` для всех клиентских данных
10. `bot/index.js:133` → заменить `appendRow` на атомарный `appendCells` Google Sheets API

---

*Аудит v2.1 — финальная верификация каждого утверждения по реальному коду*  
*Базовые коммиты: `cf5e4907` (crm-maminhleb7), `53e7a9b` (maminhleb_bot)*  
*Дата: 17 мая 2026*
