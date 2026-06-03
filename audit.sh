#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# audit.sh — исполняемый раннер аудита для MaminHleb_bot
# Прогоняет проверки из audit.config.yml и регрессионные guard'ы по живому коду.
# Использование:
#   ./audit.sh            полный прогон
#   ./audit.sh --quick    без npm audit / установки инструментов (только grep)
#   ./audit.sh --ci       режим CI: любой FAIL → exit 1
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"

QUICK=false; CI=false
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=true ;;
    --ci)    CI=true ;;
  esac
done

PASS=0; FAIL=0; WARN=0
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

ok()   { green  "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { red    "  FAIL  $1"; FAIL=$((FAIL+1)); }
warn() { yellow "  WARN  $1"; WARN=$((WARN+1)); }
section() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# ── 1. Регрессионные guard'ы (RESOLVED-баги не должны вернуться) ──────────────
section "Регрессии: ранее закрытые критические баги"

grep -q "x-telegram-bot-api-secret-token" bot/index.js \
  && ok "CRIT-001 webhook проверяет secret token" \
  || bad "CRIT-001 проверка webhook-секрета пропала"

grep -q "verifyTgInitData" bot/index.js \
  && ok "CRIT-002 HMAC-верификация initData на месте" \
  || bad "CRIT-002 verifyTgInitData удалён — initData не проверяется"

if grep -q "no-cors" bot/index.html; then
  bad "CRIT-003 mode:'no-cors' вернулся в Mini App"
else
  ok "CRIT-003 no-cors отсутствует"
fi

# Ищем именно Google Sheets API (не fonts.googleapis.com для шрифтов)
if grep -rEq "USER_ENTERED|google-spreadsheet|sheets\.spreadsheets|valueInputOption" bot/ 2>/dev/null; then
  bad "CRIT-006 вернулся Google Sheets/USER_ENTERED (formula injection)"
else
  ok "CRIT-006 Google Sheets/USER_ENTERED отсутствует"
fi

if [ -f index.html ]; then
  warn "CRIT-007 мёртвый корневой index.html снова появился"
else
  ok "CRIT-007 мёртвого корневого index.html нет"
fi

grep -q "bot_state\|storageAdapter" bot/index.js \
  && ok "CRIT-004 состояние в PostgreSQL (не state.json)" \
  || warn "CRIT-004 проверь хранилище состояния"

# ── 2. Реальные находки (см. AUDIT-VALIDATION.md) ────────────────────────────
section "Реальные находки"

if grep -q "auth_date" bot/index.js; then
  ok "VAL-BOT-01 initData проверяет auth_date (freshness)"
else
  warn "VAL-BOT-01 initData без проверки auth_date — возможен replay"
fi

if grep -q "timingSafeEqual" bot/index.js; then
  ok "VAL-BOT-04 сравнение секретов constant-time"
else
  warn "VAL-BOT-04 секреты сравниваются через !== (timing-side-channel)"
fi

if grep -q "Content-Security-Policy" bot/index.html; then
  ok "VAL-BOT-03 CSP-мета присутствует в Mini App"
else
  warn "VAL-BOT-03 нет CSP-меты + innerHTML в Mini App (XSS-поверхность)"
fi

# ── 3. Инструменты статического анализа ──────────────────────────────────────
if [ "$QUICK" = false ]; then
  section "Статический анализ"

  if [ -f eslint.config.security.js ]; then
    if npx --no-install eslint --config eslint.config.security.js bot/ >/tmp/eslint.log 2>&1; then
      ok "ESLint security — без ошибок"
    else
      warn "ESLint security — есть замечания (см. /tmp/eslint.log)"
    fi
  fi

  if [ -f .secretlintrc.json ]; then
    npx --no-install secretlint '**/*.{js,json}' >/tmp/secretlint.log 2>&1
    SL_EXIT=$?
    if grep -qE "AggregationError|is not found|Failed to load|Cannot find module" /tmp/secretlint.log 2>/dev/null; then
      warn "secretlint — пакет не установлен локально (установите: npm i -D @secretlint/secretlint-rule-preset-recommend)"
    elif [ "$SL_EXIT" -eq 0 ]; then
      ok "secretlint — секретов не найдено"
    else
      bad "secretlint — обнаружены потенциальные секреты (см. /tmp/secretlint.log)"
    fi
  fi

  section "Уязвимости зависимостей"
  if npm audit --audit-level=high >/tmp/npmaudit.log 2>&1; then
    ok "npm audit — нет HIGH/CRITICAL"
  else
    bad "npm audit — есть уязвимости (npm audit --audit-level=high)"
  fi
fi

# ── Итог ─────────────────────────────────────────────────────────────────────
section "Итог"
printf 'PASS=%d  WARN=%d  FAIL=%d\n' "$PASS" "$WARN" "$FAIL"
echo "Детали реальных находок: AUDIT-VALIDATION.md"

if [ "$CI" = true ] && [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
