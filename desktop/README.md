# MapControl desktop

## Dev-режим

Без заполненного `bundle/version.txt` обёртка ищет `../src/server.js` и запускает его системным Node.js. Запускать из `desktop/` или собирать из дерева исходников можно как раньше.

## Сборка одного файла

Из корня проекта:

```
node scripts/make-dist.cjs
```

Скрипт скачивает portable Node.js LTS, собирает production dependencies через `npm ci --omit=dev`, заполняет `desktop/bundle/`, выполняет `go build` и дымовой тест. Итоговый файл: `desktop/MapControl.exe`.

Иконка встраивается существующим `rsrc_windows_amd64.syso`. Если его нет, сначала:

```
go install github.com/akavel/rsrc@latest
cd desktop
rsrc -ico icon.ico -o rsrc_windows_amd64.syso
```

`desktop/bundle/` — только staging: в Git сохраняется `.gitkeep`, остальное готовит `make-dist.cjs`.

## Runtime и данные

Вшитые Node.js, `src/`, `public/`, конфиг и зависимости распаковываются в `%TEMP%\MapControl\<версия>`. Повторная распаковка той же версии не выполняется.

Настройки и пользовательские данные находятся в `%APPDATA%\MapControl\`:

- `.env` — создаётся из вшитого `.env.example`, существующий файл не перезаписывается;
- `ПРОЧТИ.txt` — инструкция оператору;
- `data\submissions\` — черновики, отправленные заявки и фотографии.

Для изолированной проверки можно задать `MC_USER_DIR`; рабочий exe этот параметр тоже учитывает. Секреты в `desktop/bundle/` и в `MapControl.exe` не попадают.
