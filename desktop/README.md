# MapControl desktop

Exe должен лежать здесь, в `desktop/` — сервер ищется рядом (`../src/server.js`), иначе стартует окно с ошибкой.

Сборка (Windows):
```
go install github.com/akavel/rsrc@latest   # один раз, для иконки
rsrc -ico icon.ico -o rsrc_windows_amd64.syso
go build -ldflags="-s -w -H windowsgui" -o MapControl.exe .
```
Сервер и фронт подхватываются из `../src` и `../public`, поведение не меняется.
