# Задача 0005 — add-object: прокинуть pileCount

- Проект: Zavodsvay-Static (задание трекается здесь, в MapControl) · Статус: открыта · Дата: 2026-09-23

## Цель

Публикация не теряет количество свай: `node tools/add-object.mjs` принимает `--pileCount` и пишет его в объект `data/map.json`, MapControl это поле уже собирает.

## Входит

- `tools/add-object.mjs`: флаг `--pileCount` (целое ≥ 0, опциональный), валидация, поле `pileCount` в собираемом объекте (`null` если не передан). Dry-run показывает поле в preview.
- Проверка существующего поведения не ломается: дубли id, сортировка, страница, sitemap.

## Не входит

- Переименование фото из пакета заявки (это 0006). Формат других полей не менять.

## Старт (указатели)

- Скрипт: `tools/add-object.mjs` (формирование `newObject`, валидация).
- Формат SSOT: `data/map.json` (поле `pileCount: number | null`), канон: `OBJECT_SCHEMA.md` в MapControl.

## Приёмка

- `node tools/add-object.mjs --dry-run --id 999999 --coords "55.9,57.8" --category house --title "Тест" --desc "Тест" --pileCount 25` — в preview `pileCount: 25`, файлов не меняет, несуществующий id не ругается на дубли.
- Без флага — `pileCount: null`.
- Невалидное (`--pileCount abc`, `-5`) — ошибка валидации, exit 1.
- `git diff --stat`: только `tools/add-object.mjs`. Концы строк как в файле были.
- Коммит `№0005: add-object принимает pileCount` + пуш в `main` Zavodsvay-Static.

## Ограничения

- `data/map.json`, `pages/`, `sitemap.xml`, `assets/` не трогать (только dry-run). `node_modules/`, `old/`, `.env` не трогать.
- Стоп и спроси штаба: если схема объекта в статике расходится с каноном.

## Порядок работы

Прочитай контекст статики (`docs/CONTEXT.md`) → сделай → проверь по приёмке → допиши отчёт ниже → статус «на проверке», жди.

## Отчёт сессии

- Статус: открыта
- Сделано: —
- Команды с выводами: —
- Изменённые файлы: —
- Хвосты и вопросы штабу: —
