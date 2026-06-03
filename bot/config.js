'use strict';
require('dotenv').config();

/**
 * Bot Арх #2: централизованная конфигурация и валидация схемы окружения.
 *
 * Все переменные окружения читаются и нормализуются в одном месте, а на старте
 * `validateConfig()` проверяет наличие обязательных значений и аварийно
 * завершает процесс с понятным сообщением вместо неявных сбоев в рантайме.
 */

const config = {
  // Telegram
  BOT_TOKEN:        (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim(),
  ADMIN_ID:         (process.env.ADMIN_ID || '').trim(),
  DELIVERY_CHAT_ID: (process.env.DELIVERY_CHAT_ID || '').trim(),
  WEBHOOK_SECRET:   (process.env.WEBHOOK_SECRET || '').trim(),

  // HTTP
  PORT:             parseInt(process.env.PORT, 10) || 3000,
  ALLOWED_ORIGINS:  (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Хранилище
  DATABASE_URL:     (process.env.DATABASE_URL || '').trim(),
  // На Railway PostgreSQL использует самоподписанный сертификат внутри платформы.
  // По умолчанию rejectUnauthorized: false — нужно для Railway.
  // Для собственного PostgreSQL с доверенным CA установи DATABASE_SSL=verify
  DATABASE_SSL:     (process.env.DATABASE_SSL || 'no-verify').trim(),

  // Безопасность внутренних API
  ADMIN_SECRET:     (process.env.ADMIN_SECRET || '').trim(),

  // Webhook (deploy-specific)
  WEBHOOK_BASE_URL: (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.WEBHOOK_BASE_URL || '')).trim(),
};

// Схема: имя → { required, desc }
const SCHEMA = {
  BOT_TOKEN:        { required: true,  desc: 'Токен Telegram-бота (TELEGRAM_BOT_TOKEN или BOT_TOKEN)' },
  ADMIN_ID:         { required: true,  desc: 'Telegram ID администратора для check-in и уведомлений' },
  DATABASE_URL:     { required: false, desc: 'Строка подключения PostgreSQL (без неё состояние хранится только в памяти и теряется при рестарте)' },
  WEBHOOK_SECRET:   { required: false, desc: 'Секрет X-Telegram-Bot-Api-Secret-Token — без него webhook отклоняет ВСЕ запросы с 403. Задайте случайную строку 32+ символов.' },
  ADMIN_SECRET:     { required: false, desc: 'Секрет для /api/order/done (X-Admin-Secret) — без него endpoint отклоняет ВСЕ запросы с 403. Задайте случайную строку 32+ символов.' },
  WEBHOOK_BASE_URL: { required: false, desc: 'Публичный URL для setWebhook (RAILWAY_PUBLIC_DOMAIN или WEBHOOK_BASE_URL); без него вебхук не регистрируется' },
  DELIVERY_CHAT_ID: { required: false, desc: 'Чат для уведомлений о доставке' },
};

function validateConfig() {
  const errors = [];
  const warnings = [];

  for (const [key, rule] of Object.entries(SCHEMA)) {
    const val = config[key];
    const empty = val == null || val === '' || (Array.isArray(val) && val.length === 0);
    if (!empty) continue;
    (rule.required ? errors : warnings).push(`  • ${key} — ${rule.desc}`);
  }

  if (warnings.length) {
    console.warn('[config] Необязательные переменные не заданы:\n' + warnings.join('\n'));
  }
  if (errors.length) {
    console.error('[config] Отсутствуют обязательные переменные окружения:\n' + errors.join('\n'));
    throw new Error('Некорректная конфигурация — заполните обязательные переменные окружения (см. .env.example)');
  }
  console.log('[config] Конфигурация проверена ✓');
}

module.exports = { config, validateConfig };
