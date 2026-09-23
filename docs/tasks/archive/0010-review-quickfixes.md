# Задача 0010 — быстрые фиксы из ревью (backend)

- Проект: MapControl · Статус: на проверке · Дата: 2026-09-23

## Цель

Закрыть пять мелких замечаний код-ревью одним заходом: каждый фикс независим и проверяется отдельно. Поведение для оператора не меняется.

## Входит (каждый пункт — отдельно проверяем)

1. `POST /api/shutdown` — принимать только с локальной страницы: проверка `Origin`/`Referer` на localhost (чужой origin → 403). Без токенов и новых зависимостей.
2. Тема письма — чистка переводов строк: `subjectTitle.replace(/[\r\n]+/g, ' ')` до сборки `subject` (защита от CRLF-инъекции).
3. `sharp` — лимит пикселей: `sharp(buf, { limitInputPixels: 268402689 })` (256 МП).
4. Сброс `state.llmLast` на фронте: при создании нового черновика и после успешной отправки (не подставить чужие правки).
5. Проверка `LLM_BASE_URL` на старте: `new URL(...)`, fail-fast с понятной ошибкой при мусоре в конфиге.

## Не входит

- Rate limiting, outbox, автосейв, таймауты LLM — это отдельные большие задачи, не сюда.
- `nanoid(10)` не менять. Двойной `express.static` не трогать.

## Старт (указатели)

- Сервер: `src/server.js` (shutdown, sendSubmissionEmail/subject, sharp в загрузке фото, старт).
- Фронт: `public/app.js` (`state.llmLast`, `ensureDraft`, `submitToAdmin`).

## Приёмка

- `node --check` тронутых файлов.
- Сервер стартует с кривым `LLM_BASE_URL` — падает сразу с понятной ошибкой (проверка временным env, конфиг не портить).
- `POST /api/shutdown` без Origin с localhost residual? Нет: curl без заголовков → 403, с `Origin: http://localhost:XXXX` → 200 (сервер при этом упадёт — проверять последним, поднимать заново).
- Загрузка фото работает как раньше (конвертация в WebP цела).
- Мусорный `\r\n` в заголовке заявки не ломает тему письма (юнит-проверка функцией или сквозной dry-прогон без отправки).
- `git diff --stat`: только `src/server.js`, `public/app.js`. Концы строк: код LF.
- Коммит `№0010: быстрые фиксы из ревью` + пуш в `main`.

## Ограничения

- `.env`, `data/`, `node_modules/`, `config/site.json` не трогать. Отправку писем не дёргать.
- Стоп и спроси штаба: если Origin-проверка режет легитимный сценарий лаунчера.

## Порядок работы

Прочитай контекст проекта → сделай → проверь по приёмке → допиши отчёт ниже → статус «на проверке», жди.

## Отчёт сессии

- Статус: на проверке
- Сделано: все 5 пунктов. (1) shutdown проверяет Origin/Referer на localhost — чужой/пустой → 403, без токенов. (2) тема письма чистит \r\n через replace до сборки subject. (3) sharp с limitInputPixels 268402689. (4) фронт сбрасывает state.llmLast в ensureDraft и после успешной отправки. (5) старт валидирует LLM_BASE_URL через new URL + протокол http(s), мусор → fail-fast с понятной ошибкой.
- Команды с выводами: node --check src/server.js → SERVER_OK; node --check public/app.js → APP_OK; LLM_BASE_URL=мусор → 'Invalid LLM_BASE_URL: мусор — должен быть http(s) URL' exit 1; ftp://... → unsupported protocol exit 1; стенд :5199: POST /api/shutdown без заголовков → 403 + жив, с Origin evil → 403, с Origin localhost:5199 → 200 + DEAD, с Referer localhost → 200 + DEAD; draft+upload → upload_01.webp 64x64 webp-ok; CRLF-юнит → 'Заголовок Bcc: evil...' без \r\n, CRLF-OK; концы строк LF/CRLF 0/757 и 0/433.
- Изменённые файлы: src/server.js (+30/-1: isLocalOrigin+shutdown 403, subject replace, sharp limit, LLM_BASE_URL fail-fast), public/app.js (+2: сброс llmLast ×2). git diff --stat только эти 2 файла, код LF. Тестовый черновик и временные файлы удалены.
- Хвосты и вопросы штабу: нет. Origin-проверка легитимный сценарий лаунчера не режет (лаунчер открывает localhost — Origin/Referer локальные). Коммит/пуш не делал — жду приёмки по регламенту (п.7 TASK: коммит по приёмке).
