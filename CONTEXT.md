# AutoShield AI — Project Context for Claude Code

## Что за проект
Голосовой AI-ресепшн для автогарантийной компании A-Protect Warranty (Канада).
Входящий звонок → Twilio → Express сервер → Groq (llama-3.3-70b) → Google Sheets.
B2B SaaS MVP — один клиент (A-Protect) сейчас, мультитенантность в планах, но **сознательно
отложена** до появления второго подтверждённого клиента (см. "Стратегия" ниже).

## Стек
- Node.js 18 (ESM — `"type": "module"`)
- Express
- Twilio (голос, TwiML, Polly.Matthew TTS, webhook signature validation включена)
- Groq SDK (llama-3.3-70b-versatile)
- Google Sheets API (googleapis) — де-факто CRM-адаптер, весь доступ через `sheets.js`
- Railway (деплой)

## Структура репо
```
src/
  server.js       — Express роуты, middleware, Twilio webhook validation
  callHandler.js  — вся логика звонка: state machine, промпт для AI, сессии, circuit breaker
  sheets.js       — все операции с Google Sheets (единая точка входа к CRM-данным)
  config.js       — EXTENSIONS и прочие константы
  public/
    index.html    — дашборд (одностраничник, Overview/Requests/Call Log/Warranty Lookup/Clients)
```

## Ветки и Railway
- `main` — прод, `autoshield-ai-production.up.railway.app`. **Не трогать без явного запроса.**
- `v2-dev` — вся активная разработка, отдельный Railway-сервис `Auto Shield V2dev`, своя тестовая
  Google-таблица (GOOGLE_SHEET_ID отличается от прода).
- Оба сервиса живут в ОДНОМ Railway-проекте `MVP AI Receptionist`, в одном environment
  `production` — Railway не даёт токен, ограниченный только одним сервисом, только на уровне
  проекта/окружения. Работать с Railway API/CLI только по service ID `Auto Shield V2dev`,
  `autoshield-ai` не трогать даже если токен технически даёт доступ.

## Google Sheets
- Листы: Warranties, Call Log, Requests, Plans, Security
- Service Account: `autoshield-sheets@autoshield-490605.iam.gserviceaccount.com` — расшарен на
  dev-таблицу с правами Editor (без этого все операции падают с "The caller does not have permission")
- Тестовые полисы: W100001–W100020, у каждого уникальный VIN, planType только из листа Plans.
  Примеры: W100001 — Rachel Adams, Essential, активный; W100007 — Sophie Cote, Silver, скоро
  истекает, предпочитает French (Quebec); W100008 — Brian O'Brien, Bronze, истёк; W100014 —
  Sandra Liu, Silver, claim Done.

## Twilio
- `TWILIO_AUTH_TOKEN`/`TWILIO_ACCOUNT_SID` настоящие в dev-сервисе (не placeholder).
- Webhook "Call status changes" настроен в Twilio Console → `/voice/status` — без этого звонки,
  оборванные не через явный AI-goodbye, не попадали в Call Log/Requests вообще.
- Реальных номеров отделов (EXT_SALES/CLAIMS/ACCOUNTING/MANAGEMENT) пока НЕТ, только
  placeholder (`+1555...`) — живой перевод звонка не работает, вместо этого AI сохраняет заявку
  на колбэк. Это осознанная граница текущего MVP, не баг.

## Известные архитектурные ограничения (не критично для одного клиента, но не забыть)
- Сессии звонков — в памяти процесса (`Map`), теряются при рестарте Railway. Нужен Redis для
  надёжности (актуально уже сейчас, не только под мультитенантность).
- `updateCallLog` — заглушка, recording URL никогда не пишется в Call Log.
- Directory и Roadmap-страницы дашборда — статичный HTML, не подключены к реальным данным.
- Порядок сбора полей в claim flow (issue→when_started→mileage→at_shop→symptoms) не всегда
  строго соблюдается моделью — минорная проблема на уровне промпта.

## Что уже сделано (актуально на 2026-07-06/07)
Полный цикл багфиксов, найденных через живые тестовые звонки + локальную симуляцию
(mock Sheets + реальный Groq, без Twilio):
- **Корневой баг нормализации речи**: Twilio вставляет пунктуацию между надиктованными цифрами
  (`W. 1 0 0, 0 0 1.`) — ломало извлечение номера полиса полностью. Пофикшено.
- 7-значный артефакт распознавания (лишняя цифра от Twilio) — раньше пробовались только
  "первые 6" / "последние 6" цифр, теперь перебор удаления каждой из 7 позиций (нашёл реальный
  кейс с лишним нулём в середине номера).
- Верификация личности по имени, лимиты попыток (MAX_IDENTIFY_ATTEMPTS=3, MAX_VERIFY_ATTEMPTS=2),
  security-лог при превышении.
- `s.name` сохраняется после успешной верификации (раньше терялось).
- Очистка сессий (`sessions`/`sessionsByPhone`) после завершения звонка — не было утечки памяти
  и риска подхватить чужую verified-сессию.
- Кэш Google auth клиента вместо пересоздания на каждый запрос.
- Department-значения в Requests больше не мусорные ("General — Request Saved" → "General").
- Промпт: AI больше не врёт про "сохранил заявку" без реального action; явные фразы про
  callback/тикет триггерят save_request сразу; при списке планов называет план клиента по имени;
  меньше ложных срабатываний intent=Claim на нейтральных фразах.
- **Circuit breaker на повтор ответов** — если AI дословно повторяет свою предыдущую реплику,
  принудительный graceful goodbye + логирование вместо бесконечного цикла. Заодно чинит проблему
  "звонки не попадают в дашборд" (раньше при зацикливании звонок никогда не доходил до
  goodbye → никогда не логировался).
- Twilio webhook signature validation на всех `/voice/*` роутах.
- Роут `/voice/status` подключён — auto-log при обрыве звонка.
- Дашборд: новый раздел **Clients** (список всех полисов, поиск, фильтр по статусу покрытия),
  редактируемые Name/Phone/Notes в карточке клиента (пишутся обратно в Sheets через
  `PATCH /api/warranty/:id`). Убраны захардкоженные легаси-кнопки с фейковыми полисами.

## Стратегия (принято 2026-07-06)
Сначала довести AutoShield до полного end-to-end состояния для A-Protect Warranty (единственный
текущий клиент), и только потом заниматься мультиклиентностью. **Не начинать** CRM-адаптер
интерфейс / tenant-резолвер / свою БД под мультитенантность без подтверждённого второго клиента
— это ~35-55 часов работы, которые могут оказаться преждевременной оптимизацией.

Параллельно возможна интеграция с новой внутренней CRM компании — если она на Salesforce,
`sheets.js` уже достаточно изолирован (узкий набор функций: lookupPolicy, logCall,
logRequestToSheets и т.д.), чтобы написать `salesforce.js` с теми же сигнатурами, не трогая
`callHandler.js`.

## Следующие приоритеты
1. Redis для сессий (надёжность, не мультитенантность)
2. Реальные номера отделов, когда появятся — включить живой transfer
3. `updateCallLog` — реально сохранять recording URL (потребует хранить CallSid как колонку в
   Call Log, сейчас его негде матчить)
4. По готовности — интеграция с internal CRM компании (Salesforce?)
5. Только после второго подтверждённого клиента — мультитенантность

## Как работать с проектом
```bash
git clone https://github.com/Midday02/autoshield-ai
cd autoshield-ai
git checkout v2-dev
npm install
npm run dev   # нужен .env с ключами
```

Для отладки логики разговора без реальных звонков: локальный харнесс (копия `callHandler.js` +
`config.js` + мок `sheets.js` с in-memory тестовыми полисами + реальный `GROQ_API_KEY`) — прогон
`handleIncomingCall`/`handleUserSpeech` напрямую, минуя Express/Twilio validation. Не хранится в
репо, пересоздаётся по необходимости.

## Переменные окружения (нужны в .env)
```
GROQ_API_KEY=
GOOGLE_SERVICE_ACCOUNT_JSON=  # полный JSON сервисного аккаунта, расшаренного на таблицу
GOOGLE_SHEET_ID=              # ID Google таблицы
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
EXT_SALES=101
EXT_CLAIMS=102
EXT_ACCOUNTING=103
EXT_MANAGEMENT=104
```
