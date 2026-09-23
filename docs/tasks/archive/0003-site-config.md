# Задача 0003 — конфиг сайта (backend)

- Проект: MapControl · Статус: на проверке · Дата: 2026-09-23

## Цель

Вынести захардкоженные настройки сайта zavodsvay в один конфиг, чтобы второе приложение под другой сайт отличалось только файлом настроек. Поведение не меняется ни на байт: те же категории, та же модель, тот же промпт, те же ответы API.

## Входит

- `config/site.json` — новый файл: `siteName`, `map.center`, `map.zoom`, `categories [{value,label}]`, `pileCount.required`, `llm {model, promptFile}`. Значения — ровно текущие из кода (9 категорий, центр `[56.2285, 58.014746]`, модель `qwen/qwen3.7-flash`, промпт `src/prompts/check-text.txt`).
- `src/site-config.js` — новый модуль: чтение, Zod-валидация, fail-fast на старте с понятной ошибкой.
- `src/server.js` — берёт из конфига: список категорий для валидации, модель и файл промпта для LLM, имя сайта в тему письма вместо хардкода `MapControl`. Расширить `/api/config` полями `siteName`, `categories`, `mapCenter`.
- Получатели писем остаются в `.env` (`MAIL_TO`) — это настройки установки, не сайта.

## Не входит

- Фронт не трогать вообще (подстановка центра и подписей из конфига — задача 0004).
- Формат меты заявок не менять. Поведение эндпоинтов не менять. Промпт не править.

## Старт (указатели, не пересказ)

- Сервер: `src/server.js` — места хардкода: список категорий, `LLM_MODEL`, чтение промпта, тема письма.
- Контекст проекта: `docs/CONTEXT.md` (разделы про LLM и схему), схема: `OBJECT_SCHEMA.md`.
- Пример настроек окружения: `.env.example` (читать, не править).

## Приёмка

- `node --check src/server.js && node --check src/site-config.js`
- `npm start`, `GET /api/config` отдаёт `siteName`, 9 категорий и центр карты.
- Сквозной прогон curl: создать черновик → обновить → проверить текст через LLM (ответ той же формы: `title_suggested`, `category_suggested`, `pileCount_suggested`) → применить → отправить в dry-варианте без SMTP? Нет — отправку не дёргать (нет бокса для писем): проверить валидацию `submit` на неполной заявке (400 со списком `missing`), этого достаточно.
- `git diff --stat`: только файлы из раздела «Входит». Концы строк не поплыли (код LF).
- Коммит `№0003: вынести конфиг сайта` + пуш в `main`.

## Ограничения

- `.env`, `data/`, `node_modules/` не трогать. Новый `config/site.json` — без секретов.
- Стоп и спроси штаба (прямо в отчёте, статус «на проверке»): если какой-то хардкод не ложится в предложенную схему конфига.

## Порядок работы

Прочитай контекст проекта → сделай → проверь по приёмке → допиши отчёт ниже → статус «на проверке», жди.

## Отчёт сессии

- Статус: на проверке
- Сделано: конфиг `config/site.json` (siteName MapControl, центр [56.2285, 58.014746] + zoom 9, 9 категорий с подписями из формы, pileCount.required=false, llm qwen/qwen3.7-flash + src/prompts/check-text.txt); модуль `src/site-config.js` (чтение + Zod-валидация + уникальность value + fail-fast с понятной ошибкой); `src/server.js` берёт из конфига категории (валидация), модель и файл промпта, имя сайта в теме/теле письма, `/api/config` расширен полями siteName/categories/mapCenter. Фронт не тронут, промпт не правлен, мета заявок и поведение эндпоинтов без изменений.
- Команды с выводами:
  - `node --check src/server.js && node --check src/site-config.js` — оба OK.
  - `GET /api/config` — siteName=MapControl, 9 категорий (house…other с подписями), mapCenter=[56.2285, 58.014746]; старые поля yandexMaps/limits на месте.
  - Сквозной прогон: draft 200 → update 200 → `POST /api/llm/check-text` 200 за ~2.4 с, форма та же (title_suggested/category_suggested=house/pileCount_suggested=25/confidence=high, _model=qwen/qwen3.7-flash) → apply-llm 200 (category=house, pileCount=25) → submit неполной 400 `missing: [images]`. Отправку не дёргал, тестовый черновик удалён, `data/` чистая.
  - Концы строк: config/site.json, src/site-config.js, src/server.js — LF, без CRLF.
- Изменённые файлы: `config/site.json` (нов), `src/site-config.js` (нов), `src/server.js`, `docs/tasks/0003-site-config.md` (этот отчёт).
- Хвосты и вопросы штабу:
  - `LLM_MODEL` из `.env` оставлен приоритетным (`process.env.LLM_MODEL || siteConfig.llm.model`) — живой конфиг пользователя не ломается. Если хочешь, чтобы конфиг всегда побеждал env, — скажи, одна строка.
  - `pileCount.required=false` — сейчас сваи нигде не обязательны (submit их не требует); фронт 0004 будет читать этот флаг.
  - Лог старта теперь печатает basename(promptFile) — сегодня вывод тот же (`check-text.txt`).
