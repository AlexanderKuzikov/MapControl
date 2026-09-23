# Задача 0005 — add-object: прокинуть pileCount

- Проект: Zavodsvay-Static (задание трекается здесь, в MapControl) · Статус: на проверке · Дата: 2026-09-23

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

- Статус: на проверке
- Сделано: флаг `--pileCount` в `tools/add-object.mjs` (целое ≥ 0, опциональный; `null` если не передан; поле в `newObject` после `category` — порядок как в SSOT; dry-run preview показывает автоматически). Схема статики с каноном не расходится (все 529 объектов уже имеют `pileCount: null`, порядок полей канонный) — штаб не понадобился.
- Команды с выводами:
  - `--dry-run ... --pileCount 25` → preview `pileCount: 25`, exit 0, жалоб на дубли нет
  - без флага → `pileCount: null`, exit 0
  - `--pileCount abc` → ошибка валидации, exit 1; `--pileCount -5` → ошибка валидации, exit 1; `--pileCount 2.5` → ошибка валидации, exit 1; `--pileCount 0` → `pileCount: 0`, exit 0
  - `--dry-run --id 1 ...` → `Объект с id=1 уже существует`, exit 1 (старое поведение цело)
  - `git status --short` после dry-run: только `M tools/add-object.mjs`; `git diff --stat`: 14+/1-, только этот файл; концы строк LF как в HEAD (правка шла через CRLF-нормализацию редактора, возвращены в LF, дифф точечный)
- Изменённые файлы: `tools/add-object.mjs` (Zavodsvay-Static)
- Хвосты и вопросы штабу: — (коммит `№0005: add-object принимает pileCount` + пуш не делал, жду приёмки по порядку работы)
