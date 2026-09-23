# Задача 0009 — отправка заявки в приёмник (вместо почты)

- Проект: MapControl · Статус: на проверке · Дата: 2026-09-23

## Цель

Кнопка «Отправить» везёт заявку в PHP-приёмник, а не письмом: локальный pending + POST пакета, письмо — только fallback при недоступности приёмника. Идемпотентность даёт приёмник (дубль → 409 = уже принято).

## Входит

- Конфиг: `config/site.json` → `inbox: { enabled: bool, url: string }` (адрес приёмника — не секрет, пример `https://zavodsvay.ru/inbox/`); секрет в `.env` → `INBOX_TOKEN` (читать как остальные секреты, в пример настроек добавить пустой `INBOX_TOKEN=` с комментарием). Валидация в `src/site-config.js`.
- `src/server.js`, эндпоинт submit: после локального pending — POST multipart в приёмник (`meta` = JSON меты, `images[]` = файлы из `meta.images`, токен в `X-Inbox-Token`, таймаут 30 с).
  - 200 → готово, в мету `submitted_via: inbox`, `inbox_notified` из ответа.
  - 409 → тоже готово (уже принято раньше), та же пометка.
  - 401/403 → ошибка «проверь INBOX_TOKEN», черновик цел, в pending НЕ пишем? Нет — пишем: локальный pending пишется всегда до попытки отправки (как сейчас), меняется только транспорт.
  - Сеть/таймаут/5xx → fallback: `sendSubmissionEmail` как сейчас, в мету `submitted_via: email_fallback`. Ответ оператору — успех с пометкой каким путём ушло.
- Фронт (`public/app.js`): сообщение отправки показывает путь («ушло в приёмник» / «приёмник недоступен, ушло письмом»). Больше ничего во фронте не менять.

## Не входит

- Фоновые ретраи и очередь с таймером (отдельная задача, не этот номер). Админка приёмника (готова в 0007/0008). Смена получателей письма.

## Старт (указатели)

- Submit сейчас: `src/server.js` (submit + `sendSubmissionEmail`); контракт приёмника — шапка `pages/inbox/index.php` в Zavodsvay-Static (читать, не править).
- Конфиг: `config/site.json`, `src/site-config.js`, `.env.example`.

## Приёмка

- `node --check` тронутых файлов.
- Локальный стенд приёмника (`php -S` в статике с `INBOX_TOKEN`): полный прогон draft→update→images→check→apply→submit с `INBOX_URL` на стенд → 200, заявка видна в очереди стенда, файлы = мете; повторный submit того же черновика → 409, тоже успех.
- Стенд потушен → submit уходит fallback-письмом? Нет — отправку писем не дёргать: проверить, что код зовёт `sendSubmissionEmail` (лог/мок), черновик и pending целы. Живые письма не слать.
- 401 от стенда (чужой токен) → понятная ошибка оператору, без fallback-письма (токен чинить руками, а не спамить).
- `git diff --stat`: `src/server.js`, `src/site-config.js`, `config/site.json`, `.env.example`, `public/app.js`. Концы строк: код LF. Секретов в коде нет.
- Коммит `№0009: отправка в приёмник с fallback письмом` + пуш в `main`.

## Ограничения

- `.env` (значения), `data/`, `node_modules/` не трогать. Живые письма и прод-приёмник не дёргать.
- Стоп и спроси штаба: если контракт приёмника не покрывает какой-то кейс submit.

## Порядок работы

Прочитай контекст проекта → сделай → проверь по приёмке → допиши отчёт ниже → статус «на проверке», жди.

## Отчёт сессии

- Статус: на проверке
- Сделано: submit везёт пакет в PHP-приёмник (multipart: meta + images из meta.images, шапка X-Inbox-Token, таймаут 30 с). 200/409 → submitted_via inbox (+inbox_notified из ответа); 401/403 → 502 «проверь INBOX_TOKEN» без fallback; сеть/таймаут/5xx → fallback sendSubmissionEmail + submitted_via email_fallback; приёмник выключен → старый путь письмом (via email). Конфиг inbox {enabled,url} в config/site.json (дефолт выключен, URL-пример прод-приёмника) + валидация в site-config.js (fail-fast); секрет INBOX_TOKEN в .env(.example). Фронт показывает путь: «ушло в приёмник» / «приёмник недоступен, ушло письмом». Плюс INBOX_URL — тестовый оверрайд адреса стенда (подразумевает enabled), INBOX_TIMEOUT_MS (дефолт 30000).
- Команды с выводами:
  - `node --check src/server.js src/site-config.js public/app.js` — ошибок нет.
  - `node -e require site-config` — inbox по дефолту {"enabled":false,"url":"https://zavodsvay.ru/inbox/"}; негатив (enabled true + ftp-URL) → fail-fast exit 1 «inbox.url must be http(s) URL…», конфиг восстановлен.
  - Стенд: `php -S 127.0.0.1:8779 pages/inbox/index.php` в Zavodsvay-Static (INBOX_TOKEN=t0009test, без notify — писем стенд не шлёт). Тестовый MC на :5199 (INBOX_URL на стенд, SMTP на закрытый 127.0.0.1:5999 — живые письма исключены).
  - Полный прогон draft→update→images→apply-llm→submit: submit1 → 200 {"ok":true,"via":"inbox","inbox_notified":false}; повтор → 200 via inbox (409 стенда, inbox_notified null); pending-мета submitted_via inbox, images [upload_01.webp].
  - Стенд: meta.json принят (status new, title «Тестовый объект 0009»), images/upload_01.webp на месте = мете (проверено GET action=meta + листинг каталога).
  - Чужой токен → 502 {"error":"Приёмник отклонил токен (проверь INBOX_TOKEN)"}, без fallback (иначе была бы SMTP-ошибка).
  - Стенд потушен → 500 {"error":"connect ECONNREFUSED 127.0.0.1:5999"} — доказательство, что код зовёт sendSubmissionEmail; живые письма не сланы (адресат — закрытый порт). Черновик и pending целы (оба meta.json на месте).
  - Уборка: тестовые draft/pending/inbox-каталоги удалены; `git status` в Zavodsvay-Static — чисто.
  - `git diff --stat` — ровно 5 файлов: src/server.js, src/site-config.js, config/site.json, .env.example, public/app.js. Концы строк LF во всех, секретов в диффе нет.
- Изменённые файлы: src/server.js, src/site-config.js, config/site.json, .env.example, public/app.js
- Хвосты и вопросы штабу: неуспешный submit перезаписывает pending-мету без submitted_via (статус submitted как до 0009) — с retry-очередью (вне скоупа) метка вернётся при успехе; CONTEXT.md не трогал (по правилу №3 — только свой файл + «Входит»); коммит/пуш жду приёмки.
