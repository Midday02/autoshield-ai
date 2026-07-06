# AutoShield AI — Project Context for Claude Code

## Что за проект
Голосовой AI-ресепшн для автогарантийной компании A-Protect Warranty (Канада).
Входящий звонок → Twilio → Express сервер → Groq (llama-3.3-70b) → Google Sheets.
B2B SaaS MVP — один экземпляр сейчас, в будущем мультитенантность.

## Стек
- Node.js 18 (ESM — `"type": "module"`)
- Express
- Twilio (голос, TwiML, Polly.Matthew TTS)
- Groq SDK (llama-3.3-70b-versatile)
- Google Sheets API (googleapis)
- Railway (деплой)

## Структура репо
```
src/
  server.js       — Express роуты, middleware
  callHandler.js  — вся логика звонка, AI, сессии
  sheets.js       — все операции с Google Sheets
  config.js       — EXTENSIONS и прочие константы
  public/
    index.html    — дашборд (67% кодовой базы по объёму)
```

## Ветки
- `main` — прод, задеплоен на Railway как `autoshield-ai-production.up.railway.app`
- `v2-dev` — активная разработка, задеплоен на Railway как отдельный сервис `Auto Shield V2dev`

## Railway сервисы
- `autoshield-ai` — прод, ветка `main`, не трогать
- `Auto Shield V2dev` (был `mellow-grace`) — dev, ветка `v2-dev`

## Google Sheets
- Листы: Warranties, Call Log, Requests, Plans, Security (новый, надо создать вручную)
- Dev-сервис смотрит на отдельную тестовую таблицу (GOOGLE_SHEET_ID отличается от прода)
- Service Account: autoshield-sheets@autoshield-490605.iam.gserviceaccount.com

## Тестовые полисы (в dev-таблице)
Полисы W100001–W100020, все с уникальными VIN, планы только из списка Plans.
Примеры для теста:
- W100001 — Rachel Adams, Essential, активный
- W100007 — Sophie Cote, Silver, истекает 15 июля 2026 (скоро)
- W100008 — Brian O'Brien, Bronze, истёк декабрь 2024
- W100020 — Priya Mehta, Essential, истекает через ~5 дней

## Что уже сделано в v2-dev (относительно оригинала)

### Баги пофикшены
1. **Пауза 7-8 сек + повтор приветствия** — убрана строка `r.redirect(...)` из функции `gather()`. Была гонка между слушанием речи и редиректом.
2. **Верификация по имени** — после нахождения полиса бот спрашивает имя. Пока имя не подтверждено — AI не видит данные клиента (передаётся null).
3. **Лимит попыток** — MAX_IDENTIFY_ATTEMPTS=3, MAX_VERIFY_ATTEMPTS=2. После превышения — voicemail + лог в Security.
4. **VIN только по слову "vin"** — раньше матчил любые 6 символов в конце речи.
5. **logSecurityEvent** — новая функция в sheets.js, пишет в лист Security.
6. **Нормализация номера полиса** — Twilio иногда транскрибирует W100001 как "W1 000001" (7 цифр). Добавлена логика dual-candidate: normalizeSpeech генерирует оба варианта через |, lookup перебирает оба.

### Баги в данных пофикшены
- Старые полисы имели plan_type не из списка Plans (Powertrain Plus, Comprehensive, Drivetrain Basic)
- Три полиса имели одинаковые последние 6 цифр VIN (коллизия при lookup)
- Создана новая тестовая таблица AutoShield_CRM_test_v2.xlsx

## Текущие известные проблемы (не пофикшены)

### КРИТИЧНО
1. **GOOGLE_SERVICE_ACCOUNT_JSON** в dev-сервисе возможно битый — в логах ошибка `does not contain a client_email field`. Нужно проверить что JSON полный (начинается с { заканчивается }).
2. **Полис W100001 не находится** при звонке несмотря на фикс нормализации — нужно проверить Railway Console логи на строчку `[POLICY] Candidates:` чтобы понять что именно прилетает от Twilio.
3. **Новый callHandler.js может не задеплоиться** — нужно проверить последний коммит в Deployments.

### ПРОМПТ
4. **AI зацикливается на "what issue with your vehicle"** даже когда интент Renewal/Sales — клейм-флоу не должен триггериться для не-Claim интентов.
5. **Повторяющееся приветствие** — greetedOnce не переключается пока полис не найден.
6. **handleCallStatus не подключён** в server.js — есть функция, нет роута `/voice/status`.
7. **updateCallLog — заглушка** — recording URL не сохраняется в Sheets.

### АРХИТЕКТУРА
8. **Сессии в Map()** — при рестарте Railway теряются все активные сессии. Для продакшена нужен Redis.
9. **getAuth() создаётся при каждом запросе** — нет синглтона для Google auth клиента.
10. **Нет Twilio webhook валидации** — любой может слать POST на /voice/incoming.

## Следующие приоритеты
1. Починить GOOGLE_SERVICE_ACCOUNT_JSON в dev (проверить через Console)
2. Проверить что новый callHandler.js задеплоился (должна быть строчка MAX_IDENTIFY_ATTEMPTS)
3. Пофиксить промпт — убрать vehicle issue вопрос для Renewal/Sales
4. Добавить роут /voice/status в server.js
5. Twilio webhook валидация

## Роадмап (долгосрочно)
- Мультитенантность: adapter pattern для sheets.js (каждый клиент = свой API)
- Авторизация на дашборд (сейчас открыт по ссылке)
- Клиентский портал (логин для каждого клиента)
- Salesforce интеграция для пуша лидов
- Supabase вместо Google Sheets
- Redis для сессий

## Как работать с проектом
```bash
# Клонировать и переключиться на dev ветку
git clone https://github.com/Midday02/autoshield-ai
cd autoshield-ai
git checkout v2-dev

# Установить зависимости
npm install

# Запустить локально (нужен .env с ключами)
npm run dev
```

## Переменные окружения (нужны в .env)
```
GROQ_API_KEY=
GOOGLE_SERVICE_ACCOUNT_JSON=  # полный JSON сервисного аккаунта
GOOGLE_SHEET_ID=              # ID Google таблицы
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
EXT_SALES=101
EXT_CLAIMS=102
EXT_ACCOUNTING=103
EXT_MANAGEMENT=104
```
