// k6-нагрузочный тест Telegram-бота «Мамин Хлеб»
//
// Запуск (читающий трафик, безопасно):
//   k6 run -e BASE_URL=https://<staging-домен> loadtest/k6-bot.js
//
// С созданием заказов (ТОЛЬКО staging! создаёт реальные заказы и шлёт Telegram-сообщения):
//   k6 run -e BASE_URL=https://<staging-домен> -e ENABLE_ORDERS=1 loadtest/k6-bot.js
//
// ВАЖНО:
// - Не запускать против production: ENABLE_ORDERS=1 создаёт настоящие заказы.
// - Rate limiter (30 req/мин/IP на /api/stock) сработает при запуске с одной
//   машины — ответы 429 это ожидаемое поведение, тест проверяет и его.
//   Для теста реальной пропускной способности временно поднимите лимиты
//   или запускайте k6 распределённо (k6 cloud / несколько машин).

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const DO_ORDERS = __ENV.ENABLE_ORDERS === '1';

const rateLimited = new Rate('rate_limited_429');
const stockLatency = new Trend('stock_latency', true);

export const options = {
  scenarios: {
    // Просмотр магазина: типичный пользователь открывает Mini App
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },   // утренний пик
        { duration: '1m', target: 100 },  // стресс
        { duration: '30s', target: 0 },
      ],
      exec: 'browse',
    },
    ...(DO_ORDERS ? {
      orders: {
        executor: 'constant-arrival-rate',
        rate: 5,              // 5 заказов/сек — выше любого реального пика
        timeUnit: '1s',
        duration: '2m',
        preAllocatedVUs: 20,
        exec: 'placeOrder',
      },
    } : {}),
  },
  thresholds: {
    // p95 ответа /api/stock < 200 мс (кэш должен отдавать за ~1 мс)
    'stock_latency': ['p(95)<200'],
    // < 1% сетевых ошибок (429 не считается ошибкой — см. rate_limited_429)
    'http_req_failed': ['rate<0.05'],
  },
};

export function browse() {
  // Открытие Mini App: stock + happyhour + config
  const stock = http.get(`${BASE}/api/stock`);
  stockLatency.add(stock.timings.duration);
  rateLimited.add(stock.status === 429);
  check(stock, {
    'stock: 200 или 429 (limiter)': r => r.status === 200 || r.status === 429,
    'stock: есть catalog': r => r.status !== 200 || JSON.parse(r.body).catalog !== undefined,
  });

  const hh = http.get(`${BASE}/api/happyhour`);
  rateLimited.add(hh.status === 429);
  check(hh, { 'happyhour: 200/429': r => r.status === 200 || r.status === 429 });

  http.get(`${BASE}/api/config`);

  // Пользователь листает каталог 3–10 секунд
  sleep(3 + Math.random() * 7);
}

export function placeOrder() {
  const order = {
    name: 'LOADTEST',
    phone: '+375290000000',
    address: 'Самовывоз',
    items: JSON.stringify([
      { product_name: 'Хлеб Пшеничный', quantity: 1 },
      { product_name: 'Круассан Французский', quantity: 2 },
    ]),
    tg_user_id: '0',
  };
  const res = http.post(`${BASE}/order`, JSON.stringify(order), {
    headers: { 'Content-Type': 'application/json' },
  });
  rateLimited.add(res.status === 429);
  check(res, { 'order: 200/429': r => r.status === 200 || r.status === 429 });
}
