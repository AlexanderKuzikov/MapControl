# Задача 0007 — PHP-приёмник заявок (очередь вместо почты)

- Проект: Zavodsvay-Static (задание трекается здесь, в MapControl) · Статус: на проверке · Дата: 2026-09-23

## Цель

Заявки из MapControl принимает закрытый PHP-эндпоинт на хостинге вместо почты: приём по токену, очередь на диске, мини-админка с approve/reject и скачиванием пакета. Почта остаётся только уведомлением.

## Входит

- `pages/inbox/index.php` (или рядом по роутеру проекта — уточнить по `index.php` файл-роутеру): `POST` принимает JSON меты + файлы WebP (до 20, до 30 МБ как в MapControl), auth — токен из закрытого конфига (`<home>/inbox-config.php`, вне webroot и git, формат как `callback-smtp-config.php`), складывает в `data/inbox/{submission_id}/` (`meta.json` как пришла + `images/`).
- Валидация: обязательные `submission_id ^[A-Za-z0-9_-]{1,32}$`, `title`, `techDescription`, `coords [lat,lng]`, `images[]` непусто; защита от обхода путей; атомарная запись меты.
- Мини-админка в том же файле по `GET` (закрыть тем же токеном, простейшая HTTP-basic или ключ в query — выбрать и зафиксировать в отчёте): список очереди (id, дата, заголовок, статус), просмотр меты, кнопки approve/reject с причиной (пишут `status` + `rejection_reason` в мету), скачивание пакета (мета + фото одним архивом или папкой).
- Уведомление: после приёма — письмо на адрес из конфига (использовать готовый SMTP-клиент из `pages/callback/index.php`, тот же закрытый конфиг почты): тема `[Входящие] {title} — {id}`, тело — ссылка на админку, без фото.

## Не входит

- Запись в `data/map.json` и публикация (остаётся локальной через add-object + деплой). Кадрирование фото. Фронт MapControl (это 0009).

## Старт (указатели)

- Роутер: `index.php`; образец эндпоинта с SMTP и rate-limit: `pages/callback/index.php`; закрытый конфиг почты: только на хостинге (не в git).
- Формат меты: черновик MapControl (`data/submissions/pending/{id}/meta.json` + `images/`).

## Приёмка

- Локально (`php -S`): POST без токена → 401/403; POST с токеном и валидным пакетом → 200, файлы на диске совпадают с метой; POST с кривыми координатами → 400.
- GET-список показывает принятую заявку; approve/reject пишут статус; скачивание отдаёт мету и фото.
- Дубли `submission_id` — второй приём отклоняется или версионируется (выбрать, зафиксировать).
- Деплой на прод НЕ делать (только код в репозитории; заливка — отдельной командой владельца).
- `git status --short`: только новые/тронутые файлы приёмника. Секретов и токенов в коде нет.
- Коммит `№0007: PHP-приёмник заявок` + пуш в `main` Zavodsvay-Static.

## Ограничения

- `data/map.json`, `pages/objects/`, `sitemap.xml`, `assets/img/objects/` не трогать. `node_modules/`, `old/`, любые `.env` и закрытые конфиги не трогать и не коммитить.
- Стоп и спроси штаба: выбор auth для админки, поведение дублей, куда класть файлы по роутеру проекта.

## Порядок работы

Прочитай контекст статики (`docs/CONTEXT.md`) → сделай → проверь по приёмке → допиши отчёт ниже → статус «на проверке», жди.

## Отчёт сессии

- Статус: на проверке
- Сделано: `pages/inbox/index.php` (Zavodsvay-Static) — POST-приём по токену + мини-админка в одном файле (роутер `/inbox/` → `pages/inbox/index.php`, как `/callback/`). Плюс `data/inbox/.htaccess` (`Require all denied` — webp очереди иначе отдавались бы напрямую, json уже режет корень) и `data/inbox/.gitignore` (`*` кроме них самих — очередь живёт только на хостинге).
  - POST multipart (`meta` JSON + `images[]`, до 20, каждый до 30 МБ): токен из `X-Inbox-Token` / Bearer / `?token=` / поля; валидация `submission_id ^[A-Za-z0-9_-]{1,32}$`, title 1–200 (operator_final→original), tech 1–2000, coords `[lat,lng]` в диапазонах, `images[]` непусто (имена `*.webp` без путей); файлы: размер, расширение, сигнатура `RIFF....WEBP` (без fileinfo); состав файлов строго = мете. Дубль `submission_id` → 409 без перезаписи (версионирования нет). Мета пишется как пришла + `status=new`, `inbox_received_at`, `inbox_ip`, атомарно (tmp+rename).
  - GET-админка тем же токеном в query (выбор auth — ключ в query, HTTP-basic не вводил: закрытая админка, один секрет вместо двух; зафиксировано): список (id/дата/заголовок/статус), view (мета + фото через PHP `action=image`), approve/reject POST-формами (`status=approved` / `rejected+rejection_reason` + `inbox_reviewed_at`, повторное решение → 409), скачивание `action=download` — ZIP (meta.json + images/, pure-PHP stored-writer, без php-zip — его нет и на локальном PHP), `action=meta` — meta.json.
  - Уведомление best-effort (приём уже сохранён — письмо его не отменяет, иначе ретраи MapControl давали бы дубли под 409): SMTP-клиент — копия `smtp_send/smtp_attempt` из `pages/callback/index.php` (include невозможен — файл сразу исполняется), конфиг тот же закрытый `callback-smtp-config.php`, получатель из `inbox-config.php` (`['token'=>...,'notify_to'=>...]`, формат как callback). Тема `[Входящие] {title} — {id}` (MIME-B), тело — ссылка на `/inbox/` без токена + id/координаты/время, без фото. Ответ `{"ok":true,"id":..,"images":N,"notify_sent":bool}`.
  - Конфиги ищутся как в callback (`dirname(__DIR__,4)`), локально — env `INBOX_TOKEN`/`INBOX_NOTIFY_TO`. Секретов в коде нет.
  - Баг по ходу: `inbox_inside()` сравнивал неканонический путь с `../` — приём валидного пакета давал 400; починено (`inbox_base()` через realpath + проверка через realpath каталога).
  - Внимание штабу: файл покрывает Plan.md 0007+0008 разом (POST и админка) — план можно закрыть оба пункта или переименовать.
- Команды с выводами (локально `php -S 127.0.0.1:8099 index.php`, `INBOX_TOKEN=test-token-0007`, скрипт в Temp, очередь после убрана):
  - без токена POST → 401 `unauthorized`; GET списка без токена → 401; кривые coords (lat 200) → 400 `invalid_coords`; PNG под видом webp → 400 `invalid_file_type`; `..%2F..%2Fmap` → 400
  - валидный пакет (2 webp) → 200 `{"ok":true,"id":"t0007-a","images":2,"notify_sent":false}` (false — нет SMTP/почты локально, приём всё равно 200); файлы на диске = мете, `status=new`
  - дубль → 409 `duplicate_submission_id`; approve → `status=approved`; повторный approve → 409 `already_reviewed`; reject с reason → `status=rejected` + `rejection_reason`
  - download → 200 `application/zip`, python-zipfile: `meta.json + images/2 webp`, байты фото совпали; `action=image` → 200 `image/webp`
  - итог: TOTAL 16 FAILS 0
  - `php -l` → OK; код LF, 0 CRLF; `git status --short` → только `?? data/inbox/` + `?? pages/inbox/`; секретов grep-ом нет
- Изменённые файлы: `pages/inbox/index.php`, `data/inbox/.htaccess`, `data/inbox/.gitignore` (Zavodsvay-Static, новые, не закоммичены)
- Хвосты и вопросы штабу: деплой НЕ делал (заливка — владельцем); коммит `№0007: PHP-приёмник заявок` + пуш не делал, жду приёмки. Для продакшена владельцу залить по FTP: `pages/inbox/` + создать вне webroot `inbox-config.php` (`['token'=>длинный случайный,'notify_to'=>адрес]`). Поведение утвердить: дубли → 409, админка → токен в query, ссылка в письме без токена.
