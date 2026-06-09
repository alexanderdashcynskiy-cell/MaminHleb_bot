# Нагрузочное тестирование бота

## Установка k6

```bash
# macOS
brew install k6
# Linux (deb)
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
# Windows
winget install k6 --source winget
```

## Запуск

Читающий трафик (безопасно):

```bash
k6 run -e BASE_URL=https://<staging-домен> loadtest/k6-bot.js
```

С созданием заказов — **ТОЛЬКО staging**, создаёт реальные заказы
и шлёт Telegram-сообщения админу/в чаты:

```bash
k6 run -e BASE_URL=https://<staging-домен> -e ENABLE_ORDERS=1 loadtest/k6-bot.js
```

Профиль: разгон 0 → 100 виртуальных пользователей за 3 минуты,
каждый имитирует открытие Mini App (stock + happyhour + config)
с паузой 3–10 секунд. С `ENABLE_ORDERS=1` дополнительно 5 заказов/сек.

## На что смотреть

| Метрика | Норма | Проблема |
|---|---|---|
| `stock_latency p(95)` | < 200 мс (кэш ~1–5 мс) | > 500 мс — кэш не работает, каждый запрос идёт в БД |
| `rate_limited_429` | растёт после 30 req/мин/IP | штатная работа stockLimiter |
| `http_req_failed` | < 5% | таймауты = исчерпание пула PG или CPU |

## Ограничения

- `stockLimiter` — 30 req/мин/IP: с одной машины тест быстро упрётся
  в 429. Это штатная защита, тест её тоже проверяет. Для измерения
  «чистого» потолка поднимите лимит на staging или запускайте k6
  распределённо.
- После теста с заказами удалите строки `LOADTEST` из таблицы Order:
  `DELETE FROM "Order" WHERE "customerName" = 'LOADTEST';`
