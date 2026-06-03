# SECURITY INDEX — Мамин Хлеб

> Единый индекс по безопасности: покрытие OWASP Top 10 2021 со ссылками на каждую находку
> и артефакт. Дата: 2026-06-02. Детали — в `DEEP-AUDIT-SUMMARY.md`, `DATA-SECURITY.md`,
> `AUDIT-VALIDATION.md`, `RECONCILIATION-280.md`.

## Артефакты безопасности (где что искать)
| Файл | Назначение |
|---|---|
| `audit.config.yml` | Чеклист OWASP/CWE (52 CRM / 55 бот) |
| `eslint.config.security.js` · `.secretlintrc.json` | Правила статанализа + поиск секретов |
| `audit.sh` | Исполняемые проверки (регрессии + SAST), PASS/WARN/FAIL |
| `.github/workflows/security.yml` | CI: npm audit · secretlint · eslint · регрессии |
| `AUDIT-VALIDATION.md` | Сверка backend-безопасности с живым кодом |
| `DEEP-AUDIT-REPORT.md` / `-SUMMARY.md` | Security-находки с файл:строка + беклог |
| `DATA-SECURITY.md` | Защита данных (PII, логи, AI, retention, at-rest) |
| `RECONCILIATION-280.md` | Статус 280 проблем майского аудита |
| `audit-report.pdf` | Печатный отчёт |

## Покрытие OWASP Top 10 2021
| OWASP | Покрыто | Находки (ID) | Статус |
|---|---|---|---|
| **A01** Контроль доступа | ✅ | CRM-H2 (RBAC в UI), CRM-H3 (открытые endpoint'ы), BOT-H1/DS-01 (IDOR), BOT-M1 (спуфинг) | 🔴 есть критичное |
| **A02** Криптография | ✅ | CRM-H1/DS-05 (plaintext-пароли), CRM-M1 (token в sessionStorage), CRM-L1/BOT-L1 (не constant-time) | 🔴 есть критичное |
| **A03** Инъекции | ✅ | SQL — параметризовано ✓; XSS — 0 DOM-стоков (CRM) ✓, escHtml (бот) ✓; formula injection — удалено ✓; BOT-M4 (CSP-нет) | 🟡 остаточно |
| **A04** Небезопасный дизайн | ✅ | BOT-M1 (доверие telegramId), DS-04 (данные на устройстве) | 🟡 |
| **A05** Мисконфигурация | ✅ | CRM-M3 (нет helmet), BOT-M4 (CSP отключён), CORS (BOT-L2) | 🟡 |
| **A06** Уязвимые зависимости | ✅ | `npm audit` в CI; BOT (node-fetch@2 устарел); BOT-M2 (Tailwind CDN) | 🟡 |
| **A07** Аутентификация | ✅ | Логин/токены, HMAC initData ✓, webhook secret ✓, BOT-M5 (нет auth_date) | 🟡 |
| **A08** Целостность ПО/данных | ✅ | BOT-M2 (CDN без SRI) | 🟡 |
| **A09** Логирование/мониторинг | ✅ (добавлено) | DS-02 (PII в логах), EXT-B (нет Pino/Sentry), `catch{}` (CRM-L2) | 🟡 |
| **A10** SSRF | ✅ | Проверено — со стороны клиента нет; серверные fetch только к api.telegram.org/Gemini | ✅ чисто |

## Сводка security-находок
| Severity | Кол-во | ID |
|---|---|---|
| HIGH | 3 | CRM-H1, CRM-H2/H3, BOT-H1 |
| MEDIUM | 10 | CRM-M1..M6, BOT-M1..M5 |
| LOW | 10 | CRM-L1..L6, BOT-L1..L4 |
| INFO | 1 | CRM-I1 (снято) |
| Данные (доп.) | DS-01..09 | см. DATA-SECURITY.md |

**Критических (CRITICAL) — нет.** Приоритет №1 (Спринт 1): A01+A02 — RBAC на сервере,
bcrypt-пароли, IDOR в боте.

## Что проверено как «чисто» (позитив)
- SQL-инъекции: Prisma ORM + параметризованные запросы в боте (`$1..$N`).
- DOM-XSS в CRM: 0 `innerHTML/eval/dangerouslySetInnerHTML`.
- XSS в Mini App: `escHtml` применён ко всем пользовательским данным.
- Секреты: `.env` в gitignore, ключи только на сервере, нет утечки в бандл.
- SSRF: со стороны клиента нет; внешние вызовы — только доверенные домены.
- Telegram: HMAC-верификация initData, webhook secret-token.
