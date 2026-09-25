# Задача 0020 — один бинарник: всё вшито в exe (go:embed)

- Проект: MapControl · Статус: на проверке · Дата: 2026-09-25

## Цель

Заказчик получает РОВНО ОДИН файл `MapControl.exe` и работает: Node.js, `node_modules`, `src/`, `public/` зашиты внутрь через `go:embed`, при старте распаковываются сами. SFX-вариант отменён штабом (лишний 7z в цепочке, временные файлы наружу); переписывание сервера на Go отвергнуто ранее (WebP тянет натив обратно). Уточнение пользователя: «без зависимостей» = без дополнительных файлов рядом.

## Входит

- `desktop/bundle/` (staging, в git только `.gitkeep`; остальное в `.gitignore`): `bin/node.exe` (portable LTS с nodejs.org — качает скрипт), `app/` (`src`, `public`, `config/site.json`, `package.json`, `node_modules` через `npm ci --omit=dev`), `version.txt` (хеш коммита + дата — пишет скрипт).
- `desktop/main.go`: `//go:embed bundle`; если `version.txt` пуст — dev-режим как сейчас (дерево исходников); иначе: распаковать bundle во временный каталог с именем версии (повторно — только при смене версии), пользовательские файлы — в `%APPDATA%/MapControl/` (создать; `.env` скопировать из примера если нет), запустить вшитый node с `PORT`, `MC_DATA_ROOT`, `MC_ENV_FILE`; для тестов — оверрайд каталога через `MC_USER_DIR`.
- `src/server.js` (минимально, упаковка требует): `SUBMISSIONS_ROOT` из `MC_DATA_ROOT` при наличии, путь dotenv из `MC_ENV_FILE` при наличии. Больше ничего в сервере не менять.
- `scripts/make-dist.cjs` (node, без зависимостей): готовит bundle, пишет version, `go build` как в README, дымовой прогон, отчёт о размере.
- `ПРОЧТИ.txt` оператора: запуск, где лежат `.env`/`data` (%APPDATA%), и честный абзац про SmartScreen (файл новый и без подписи — Windows покажет предупреждение, обход: «Подробнее» → «Выполнить в любом случае»; при ложном срабатывании Defender — отправить файл на проверку Microsoft).
- `.gitignore`: `desktop/bundle/` (кроме `.gitkeep`).

## Не входит

- Установщик/MSI, автообновление, подпись бинаря. Секреты в бинарь не вшивать (только `.env.example`; `.env` создаётся рядом с пользовательскими данными).

## Старт (указатели)

- Обёртка: `desktop/main.go` (запуск node, MessageBox, иконка); пример настроек: `.env.example`; текущий запуск: `launcher.js` (порты), `desktop/README.md`.

## Приёмка

- `gofmt`/`go vet` чисто; `node --check scripts/make-dist.cjs` и изменённого `src/server.js`.
- Собранный exe (~70–90 МБ; если >150 — стоп к штабу) запущен из пустой папки БЕЗ node в PATH, с тестовым `MC_USER_DIR` → `/api/config` отвечает, черновик создаётся, данные легли в тестовый каталог (не в `%APPDATA%` и не в репо); мусор (тестовый каталог, черновики) убрать.
- Dev-режим не сломан: сборка/запуск из дерева исходников работает как раньше (без bundle).
- `git status --short`: только `desktop/main.go`, `scripts/make-dist.cjs`, `src/server.js`, `.gitignore`, `desktop/README.md`, `desktop/bundle/.gitkeep` (+ этот файл). Бинари, bundle-содержимое, `.env` в коммит не идут.
- Коммит `№0020: один бинарник` + пуш в `main`.

## Ограничения

- `npm install/ci` на машине сборки — можно (это явно нужно), с флагом `--omit=dev`. Sharp из временного каталога обязан грузиться — проверить в приёмке сквозным upload (не только draft).
- Стоп и спроси штаба: раскладка пользовательского каталога; размер; native-модуль не грузится из Temp.

## Порядок работы

Прочитай контекст проекта → сделай → проверь по приёмке → допиши отчёт ниже → статус «на проверке», жди.

## Отчёт сессии

- Статус: на проверке
- Сделано:
  - `desktop/main.go` встраивает staging через `//go:embed all:bundle`. Префикс `all:` нужен именно для разрешённого состояния «в Git только `.gitkeep`»: обычный `//go:embed bundle` не видит скрытый файл и не собирает dev-режим.
  - При пустом `version.txt` Go-обёртка работает как раньше: находит `src/server.js` в дереве и запускает системный Node. При непустой версии атомарно распаковывает bundle в `%TEMP%\MapControl\<версия>`, переиспользует готовый cache, сериализует одновременную распаковку Windows mutex и проверяет полный набор embedded-файлов по размеру.
  - Production runtime запускает вшитый `node.exe` абсолютным путём с `PORT`, `MC_DATA_ROOT=<user-dir>\data\submissions`, `MC_ENV_FILE=<user-dir>\.env`. Пользовательский каталог по умолчанию `%APPDATA%\MapControl`; `MC_USER_DIR` переопределяет его. `.env` и `ПРОЧТИ.txt` создаются только при отсутствии, существующий `.env` не перезаписывается.
  - `src/server.js` минимально поддержал `MC_ENV_FILE` и `MC_DATA_ROOT`; остальная серверная логика не менялась.
  - `scripts/make-dist.cjs` выбирает последний Windows x64 LTS из официального `nodejs.org`, проверяет SHA-256 по `SHASUMS256.txt`, выполняет `npm ci --omit=dev` внутри staging, собирает `desktop/MapControl.exe` и запускает изолированный smoke без Node в `PATH`.
  - Smoke проверяет `/api/config`, создание draft, реальный upload PNG → WebP через native `sharp` из `%TEMP%`, размещение данных в `MC_USER_DIR`, создание `.env`/`ПРОЧТИ.txt`, отсутствие orphan-процессов и удаление тестового каталога.
  - `ПРОЧТИ.txt` генерируется в ignored staging и копируется в пользовательский каталог, поэтому заказчик получает один exe и Git status остаётся в whitelist задачи.
  - `desktop/README.md` переведён на новый dev/dist-процесс; `.gitignore` исключает bundle-кроме-`.gitkeep`.
- Команды с выводами:
  - `node scripts/make-dist.cjs` → `Portable Node: v24.21.0`; `added 92 packages in 2s`; `MapControl.exe: 128.21 MiB`; `Smoke test: /api/config, draft, WebP upload, user directory — OK`; `Distribution ready: D:\GitHub\MapControl\desktop\MapControl.exe (67f1b7f95655-dirty-20260925T062712220Z)`; exit code `0`.
  - `gofmt -d main.go && go vet ./... && go test ./...` → чисто; `? mapcontrol-desktop [no test files]`.
  - `node --check scripts/make-dist.cjs && node --check src/server.js` → exit code `0`, без вывода.
  - `git -c core.whitespace=cr-at-eol diff --check` → exit code `0`; CRLF сохранён у `.gitignore`, LF у Go/JS/docs.
  - Dev-exe, собранный при наличии только `.gitkeep`, запущен из `desktop/`; `GET http://localhost:5179/api/config` → `200`, `siteName: "MapControl"`, `yandexMaps` присутствует. Процесс дерева затем остановлен.
  - `git status --short --untracked-files=all` → только `.gitignore`, `desktop/README.md`, `desktop/main.go`, `src/server.js`, `desktop/bundle/.gitkeep`, `scripts/make-dist.cjs` и этот task-файл. Ignored: exe и bundle-кроме-`.gitkeep`; `.env` внутри bundle не найден.
  - После smoke `mapcontrol-dist-smoke-*` не найден; неудачные staging/старые cache удалены, актуальный cache версии оставлен.
- Изменённые файлы:
  - `.gitignore`
  - `desktop/README.md`
  - `desktop/main.go`
  - `desktop/bundle/.gitkeep`
  - `scripts/make-dist.cjs`
  - `src/server.js`
  - `docs/tasks/0020-dist-package.md`
- Хвосты и вопросы штабу:
  - Exe получился `128.21 MiB`: выше ориентировочных `70–90 MiB`, но ниже жёсткого стопа `150 MiB`. Нужна приёмка размера; дальнейшая оптимизация потребует отдельного решения по формату/составу runtime.
  - Коммит и push не выполнялись: задание переведено в «на проверке» и ждёт приёмки штаба.
