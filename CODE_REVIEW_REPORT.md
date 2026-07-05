# MapControl — Отчёт код-ревью

**Дата:** 2026-07-05  
**Ревьюер:** Hermes Agent (nvidia/nemotron-3-ultra-550b-a55b:free)  
**Репозиторий:** https://github.com/AlexanderKuzikov/MapControl  
**Коммит:** `52cf69a` (main branch, up to date with origin)  
**Область:** Полный анализ кодовой базы — архитектура, бэкенд, фронтенд, схема данных, LLM интеграция, email, деплой, безопасность, тестируемость

---

## Executive Summary

| Метрика | Оценка | Вердикт |
|---------|--------|---------|
| **Overall** | **7.5/10** | Сильный MVP, готов к операторскому пилоту |
| **Architecture** | 8/10 | Чистая, модульная, чёткое разделение ответственности |
| **Backend** | 7/10 | Хорошая валидация, защита путей, атомарные записи. Нет: rate limiting, async email, LLM timeouts, sharp limitInputPixels, shutdown auth |
| **Frontend** | 7.5/10 | Современный vanilla JS, отличный UX (diff, paste, EXIF), проф. Sky Pro CSS. Минусы: нет auto-save, llmLast leak, фото обязательно для LLM check |
| **Data Schema** | 9/10 | Эталонная документация, чёткое разделение SSOT vs Buffer, audit trail |
| **LLM Integration** | 7/10 | Правильные параметры, валидация ответа. Риск: provider lock-in, нет timeout/retry |
| **Email** | 6/10 | Работает, но синхронно в критическом пути — блокер для production. Subject injection risk. |
| **Windows Deployment** | 9.5/10 | Золотой стандарт лаунчера для локальных Node apps |
| **Documentation** | 9/10 | README + CONTEXT + OBJECT_SCHEMA — образец для pet-проектов |
| **Testability** | 3/10 | Нет тестов, TypeScript, linting, CI |
| **Security** | 6/10 | База покрыта, нет rate limiting, magic bytes validation, shutdown без auth, CRLF injection в subject, double express.static |

**Key Blockers for Production:**
1. **Email outbox pattern** (fire-and-forget + retries)
2. **Draft auto-save** (debounce 2s, localStorage fallback) — потеря данных оператора
3. **LLM fetch timeout + retry** (429/5xx handling)
4. **Shutdown endpoint auth** (любой может убить сервер)
5. **Email subject CRLF injection** (sanitize \r\n)

---

## 1. Architecture & Structure

### Repository Layout
```
MapControl/
├── CONTEXT.md              # Живой контекст разработки, решения, roadmap
├── README.md               # Обзор проекта, установка, tech stack
├── OBJECT_SCHEMA.md        # Каноническая спецификация данных (SSOT + Submission)
├── CODE_REVIEW_REPORT.md   # Этот файл
├── launcher.js             # Автопорт, health-check, открытие браузера, скрытый запуск
├── start.vbs               # Точка входа лаунчера без консоли
├── update.bat              # git pull + npm ci, проверка что сервер остановлен
├── update.vbs              # Скрытый запуск update.bat
├── .env.example            # Шаблон конфигурации
├── public/
│   ├── index.html          # SPA entry point, Sky Pro theme, exit/help dialogs
│   ├── app.js              # Frontend логика (vanilla ES modules)
│   ├── styles.css          # Sky Pro design system, dark/light, локальные шрифты Inter
│   └── fonts/              # 8 woff2 файлов (latin/cyrillic 400-700)
├── src/
│   ├── server.js           # Express API (single file, ~620 строк)
│   └── prompts/
│       └── check-text.txt  # System prompt для LLM
├── scripts/
│   └── create-shortcuts.vbs # Генератор ярлыков на рабочий стол
└── data/
    └── submissions/
        ├── draft/          # Черновики оператора
        ├── pending/        # Отправленные на ревью админу
        └── archive/        # Опубликованные/отклонённые
```

### Сильные стороны
- **Чёткое разделение**: API (`src/server.js`) | UI (`public/`) | Launcher (`launcher.js`)
- **Файловое хранилище**: `data/submissions/{draft,pending,archive}/{id}/meta.json + images/` — простое, переносимое, аудитируемое
- **Минимальные зависимости**: express, multer, sharp, nodemailer, zod, exifr, nanoid, dotenv — все актуальны, нет лишнего
- **Windows-first деплой**: `start.vbs → launcher.js` решает автопорт (5179-5279), `localhost` (критично для Яндекс.Карт API ключа), health-check, логирование, PID-файл — best-in-class для локальных Node apps

---

## 2. Backend Analysis (`src/server.js`)

### Strong Points ✅

| Фича | Почему это важно |
|------|-----------------|
| **Zod validation на всех эндпоинтах** (`CreateDraftSchema`, `UpdateDraftSchema`, `CheckTextSchema`, inline в `apply-llm`) | Runtime type safety, понятные 400 ошибки |
| **Path traversal защита** (`assertInsideSubmissions`, `sanitizeId` regex `^[A-Za-z0-9_-]{1,32}$`) | Блокирует `../../etc/passwd` атаки |
| **Атомарные JSON записи** (`writeJsonAtomic` через `.tmp-<ts>` + `rename`) | Нет битых JSON при краше |
| **EXIF GPS извлечение ДО sharp** (`exifr.parse(f.buffer)`) | Метаданные не теряются при ресайзе |
| **Фильтрация вложений по `meta.images`** (не `readdir`) | Фикс накопления orphan-файлов (2026-07-04) |
| **LLM payload tuned for Qwen**: `temp 0.1`, `response_format: json_object`, `chat_template_kwargs: {enable_thinking: false}` | Детерминированный вывод, структурированный, без reasoning bloat |
| **Fallback `` strip** | Защита от провайдеров, игнорирующих `enable_thinking` |
| **Graceful shutdown endpoint** (`POST /api/shutdown`) | Чистый UX выхода без зависшего браузера |

### Issues & Vulnerabilities ⚠️

| # | Issue | Risk | Fix |
|---|-------|------|-----|
| **1** | **Нет rate limiting** на `/api/llm/check-text`, `/api/submissions/draft/:id/images` | DoS на LLM API, утечка токенов | `express-rate-limit` по IP + `submissionId` |
| **2** | **Синхронный SMTP в `submit`** (стр. 583) | SMTP timeout (30-60с) → оператор ждёт, возможен 504 | **Outbox pattern**: `setImmediate(() => sendEmail().catch(log))`, вернуть 200 сразу |
| **3** | **Нет таймаута на LLM `fetch`** | Вечный hang при проблемах провайдера | `AbortController` + `setTimeout(30s)` |
| **4** | **Нет ретраев на LLM** (429, 5xx) | Переходные ошибки ломают UX оператора | Exponential backoff retry (3 попытки) |
| **5** | `nanoid(10)` — ~64 бита энтропии | Коллизии маловероятны, но non-standard | `nanoid(21)` или `nanoid()` |
| **6** | `LLM_BASE_URL` не валидируется как URL | Непонятная ошибка fetch на плохом конфиге | `new URL(LLM_BASE_URL)` на старте |
| **7** | `sharp` без `limitInputPixels` | Злой TIFF/HEIF может съесть RAM (DoS) | `sharp(buf, { limitInputPixels: 268402689 })` (256MP) |
| **8** | **`/api/shutdown` без auth** | Любой `curl -X POST localhost:5179/api/shutdown` убивает сервер | Проверка `Origin`/`Referer` или токен в заголовке |
| **9** | **CRLF injection в email subject** (стр. 158) | `subjectTitle` содержит `
` → инъекция заголовков письма | `.replace(/[
]/g, ' ')` перед использованием |
| **10** | **Два `express.static`** (`/` + `/assets`) на одной папке | Дублирование, путаница | Оставить один (`/`) или разделить папки |
| **11** | Нет request logging (morgan/pino) | Сложно дебажить production | Добавить `pino` + pretty transport для dev |
| **12** | Промпт грузится 1 раз при старте | Изменение `check-text.txt` требует рестарта | Hot-reload (`fs.watch`) или `/api/reload-prompt` |
| **13** | `Date.now()` коллизия в `writeJsonAtomic` (стр. 83) | Два вызова в 1 мс = одинаковый tmp файл | `crypto.randomUUID()` или `nanoid()` в имени tmp |

### Recommended Improvements 💡

- **Health endpoint** (`/api/health`) — мониторинг, docker, launcher checks
- **Request ID** (nanoid) + structured logging — корреляция frontend↔backend логов
- **Unified `SubmissionMeta` Zod schema** — single source of truth (сейчас разбросана по эндпоинтам)
- **Config через Zod** (`envSchema.parse(process.env)`) — fail-fast с понятными сообщениями

---

## 3. Frontend Analysis (`public/app.js`, `index.html`, `styles.css`)

### Strong Points ✅

| Фича | Оценка |
|------|--------|
| **Vanilla ES modules** (`type="module"`) | Нет бандлера, быстро, прозрачно |
| **Sky Pro design system** | CSS variables, dark/light theme, локальные шрифты Inter (woff2, unicode-range) — проф. уровень |
| **Split button "Check / AI"** | UX pattern для частых/редких действий |
| **Diff UI** (original vs suggested) | Оператор видит, что именно меняет LLM |
| **Paste coordinate parsing** (`55.915, 57.870` → auto-split) | Удобно для copy-paste из карт/Excel |
| **EXIF GPS auto-fill** после загрузки фото | Уменьшает ручной ввод |
| **Exit flow**: confirm → `/api/shutdown` → "Server stopped / Close window" | Не вешает браузер, чистый UX |
| **Help overlay** с контекстными подсказками | Онбординг встроен |
| **Dynamic Yandex Maps v3 load** только при наличии API ключа | Graceful degradation |

### Issues ⚠️

| # | Issue | Impact |
|---|-------|--------|
| **1** | `state.llmLast` не очищается при смене черновика | Утечка данных между заявками — applySuggested подставит чужие правки |
| **2** | `validateBeforeCheck()` требует фото, но LLM проверяет только текст | Принудительная загрузка фото перед проверкой текста — лишний шаг |
| **3** | Нет индикаторов загрузки на кнопках (только `disabled`) | Пользователь не видит прогресс |
| **4** | **Нет auto-save черновика** | Потеря данных при краше браузера/сети — **P0** |
| **5** | `parseNum` не обрабатывает пробелы в числах (`55.915 172`) | Minor UX friction |
| **6** | Hardcoded `initialCenter: [56.2285, 58.014746]` (Пермь?) | Для локального инструмента завода ок, но лучше из `.env` |
| **7** | Нет drag&drop, нет превью фото | Upload UX можно улучшить |
| **8** | `ymaps3` нет cleanup при reload страницы | Memory leak (minor для SPA) |
| **9** | `@import url('https://fonts.googleapis.com/...')` в CSS | Внешняя зависимость — ломает офлайн работу. Шрифты уже локально в `public/fonts/` |

### UX Ideas 💡

- Auto-save draft (debounce 2s, localStorage fallback) — **P0**
- Optimistic UI updates
- Drag&drop + thumbnail grid для фото
- Copy submission JSON button (debugging)
- Toast notifications вместо inline `msg`
- Убрать Google Fonts `@import`, оставить только локальные `@font-face`

---

## 4. Data Schema (`OBJECT_SCHEMA.md`, `meta.json`)

### Excellent Documentation ✅

- **Чёткое разделение SSOT**: `Zavodsvay-Static/data/map.json` (опубликованные) vs MapControl submissions (буфер)
- **Полные спецификации полей**: типы, правила, enums, примеры
- **`pileCount` guardrails**: "LLM не должен выдумывать — только извлекать если явно указано"
- **Submission audit trail**: `original → llm_suggested → operator_final → admin_final`
- **LLM metadata captured**: provider, model, latency, usage, warnings, confidence

### Code ↔ Schema Gaps ⚠️

| Schema Field | В коде | Статус |
|--------------|--------|--------|
| `title_llm_suggested` / `techDescription_llm_suggested` | ❌ Только в `llm` объекте при apply | Добавить в `/check-text` response |
| `title_admin_final` / `techDescription_admin_final` | ❌ Admin UI не построена | OK для MVP |
| `category_admin` | ❌ | OK для MVP |
| `rejection_reason` | ❌ | Добавить для reject flow |
| `published_object_id` | ❌ | Добавить при publish |
| `images[].cropped_filename` / `notes` | ❌ | Для админки cropping |

**Recommendation**: Вынести unified `SubmissionMeta` Zod schema в `src/schemas/submission.js` — single source для backend + TypeScript type generation для frontend.

---

## 5. LLM Integration

### Well Configured ✅

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `temperature` | 0.1 | Детерминированный вывод |
| `max_tokens` | 512 | Достаточно для JSON ответа |
| `response_format` | `{type: 'json_object'}` | Принудительный JSON |
| `chat_template_kwargs` | `{enable_thinking: false}` | Отключает Qwen reasoning (экономит ~70% токенов) |
| Response validation | `LlmOutSchema` (Zod) | Fail-fast на невалидном JSON |
| Metadata в ответе | `_provider`, `_model`, `_latency_ms`, `_usage`, `_prompt_version` | Полная observability |
| Fallback cleanup `` | Обрабатывает non-compliant провайдеров |

### Risks ⚠️

| Risk | Details |
|------|---------|
| **Provider lock-in (RouterAI)** | `chat_template_kwargs` — vLLM-specific, не стандарт OpenAI. Нужен `buildLlmPayload(provider)` abstraction |
| **Нет fetch timeout** | Может висеть вечно — добавить `AbortController(30s)` |
| **Нет ретраев** | 429/5xx = сломанный UX — нужен exponential backoff |
| **Prompt hot-reload missing** | Требует рестарт сервера |
| **`pileCount_suggested` hallucination risk** | Промпт говорит "only if explicit" но LLM может угадать. Добавить: "If uncertain, omit field entirely" |

---

## 6. Email / SMTP (`nodemailer` v8)

### Good ✅
- HTML + text multipart
- Вложения отфильтрованы по `meta.images` (orphan protection)
- Raw JSON в `<pre>` для парсинга админкой
- **Generic SMTP config** — поддерживает Gmail, корпоративную zavodsvay.ru, Yandex 360, mail.ru

### Production Blockers ❌

| Issue | Fix |
|-------|-----|
| **Синхронный в `submit`** | Outbox pattern: `setImmediate(() => sendEmail().catch(log))`, вернуть 200 сразу |
| **Нет ретраев** | Отдельный процесс/интервал ретраев, логирование статусов в `meta.email_log[]` |
| **Один получатель** (`MAIL_TO`) | План: `MAIL_TO` (queue) + `MAIL_NOTIFY` (personal) — not implemented |
| **CRLF injection в subject** (стр. 158) | `subjectTitle` не санитизирован — `.replace(/[
]/g, ' ')` |
| **Нет DKIM/SPF проверки** | Письма могут попасть в спам |

---

## 7. Windows Deployment — **9.5/10**

| Component | Role |
|-----------|------|
| `start.vbs` | Hidden `node launcher.js` launch (нет консоли) |
| `launcher.js` | Автопорт (5179-5279), `localhost` (Yandex key compat), health-check `/api/config`, открытие браузера, логи в `logs/server.log`, PID файл |
| `update.bat` | `git pull` + `npm ci --omit=dev`, проверка что сервер остановлен (curl 5179) |
| `update.vbs` | Hidden `update.bat` launch |
| `create-shortcuts.vbs` | Генерирует `MapControl.lnk` + `Update MapControl.lnk` с правильными путями/иконками |

### Minor Issues
- `update.bat` чекает только порт 5179 — launcher может использовать 5180+. Читать `server.pid` или чекать диапазон.
- `favicon.ico` referenced в shortcut но не существует.
- `logs/server.log` нет ротации — добавить `pino` rotation или daily rename.

---

## 8. Security Assessment

| Vector | Status | Notes |
|--------|--------|-------|
| Path traversal | ✅ Protected | `assertInsideSubmissions` + `sanitizeId` |
| XSS (email HTML) | ✅ Protected | `escapeHtml` на всех user fields |
| XSS (frontend) | ✅ Protected | Только `textContent`/`value`, нет `innerHTML` |
| CSRF | ⚠️ N/A | Localhost, нет cookies/sessions |
| Rate limiting | ❌ Missing | Добавить на LLM + upload endpoints |
| File upload validation | ⚠️ Partial | `sharp` metadata + format whitelist, но нет magic bytes check, нет `limitInputPixels` |
| Max file size | ✅ Limited | `multer: 30MB, files: 20` |
| Secrets in code | ✅ None | Только `.env` |
| LLM API key in logs | ✅ No | Логгируется только model/latency/usage |
| **Shutdown auth** | ❌ Missing | `/api/shutdown` открыт для всех |
| **CRLF injection (email)** | ❌ Vulnerable | `subjectTitle` в subject без санитизации `
` |
| **Double express.static** | ⚠️ Minor | Дублирование маунта одной папки |

---

## 9. Testability & Code Quality — **3/10**

| Aspect | Status |
|--------|--------|
| Unit tests | ❌ None |
| Integration tests | ❌ None |
| TypeScript | ❌ Plain JS + JSDoc в схемах |
| ESLint / Prettier | ❌ Not configured |
| CI/CD (GitHub Actions) | ❌ None |
| Error boundaries | ❌ Manual try/catch everywhere |

**Minimum for Production-Ready:**
```bash
npm i -D eslint prettier @types/node typescript vitest
# tsconfig.json с checkJs: true + JSDoc types
# vitest для Zod schemas, utilities (parseNum, sanitizeId, escapeHtml)
# GitHub Action: lint + test + build check
```

---

## 10. Priority Action Items

| Priority | Task | Estimate |
|----------|------|----------|
| 🔥 **P0** | **Email outbox** (fire-and-forget + retries + `meta.email_log[]`) | 2-3h |
| 🔥 **P0** | **Draft auto-save** (debounce 2s, localStorage fallback) | 3-4h |
| 🔥 **P0** | **LLM fetch timeout + retry** (`AbortController(30s)` + retry 429/5xx) | 1-2h |
| 🔥 **P0** | **Shutdown endpoint auth** (проверка Origin/Referer) | 30 мин |
| 🔥 **P0** | **Email subject CRLF sanitization** (`.replace(/[
]/g, ' ')`) | 10 мин |
| 🟡 **P1** | **Rate limiting** на `/api/llm/check-text` и `/images` | 1h |
| 🟡 **P1** | **sharp limitInputPixels** (256MP) | 5 мин |
| 🟡 **P1** | **nanoid(21)** вместо `nanoid(10)` | 5 мин |
| 🟡 **P1** | **writeJsonAtomic tmp collision fix** (`nanoid()` вместо `Date.now()`) | 5 мин |
| 🟡 **P1** | **express.static dedup** (убрать `/assets` mount) | 5 мин |
| 🟡 **P1** | **Убрать Google Fonts @import** из CSS (шрифты уже локально) | 10 мин |
| 🟡 **P1** | **LLM provider abstraction** (`buildLlmPayload(provider)`) | 4-6h |
| 🟡 **P1** | **Validate LLM_BASE_URL** на старте | 10 мин |
| 🟢 **P2** | **state.llmLast сброс** при новом черновике | 10 мин |
| 🟢 **P2** | **validateBeforeCheck** — убрать требование фото для LLM check | 10 мин |
| 🟢 **P2** | **Loading indicators** на кнопках | 30 мин |
| 🟢 **P2** | **Drag&drop фото + превью** | 2-3h |
| 🟢 **P2** | **Two email recipients** (`MAIL_TO` + `MAIL_NOTIFY`) | 30 мин |
| 🟢 **P2** | **favicon.ico** или убрать из `.vbs` | 10 мин |
| 🟢 **P2** | **Log rotation** (`pino` или daily rename) | 30 мин |
| 🔵 **P3** | **TypeScript + tests + CI** (vitest, eslint, GitHub Actions) | 1-2 дня |
| 🔵 **P3** | **Admin circuit** (pending list, view, crop, publish) | 1-2 недели |
| 🔵 **P3** | **Export to Zavodsvay-Static format** (`map.json` + assets) | 1 неделя |
| 🔵 **P3** | **LLM latency monitoring** (JSON log или Prometheus) | 2h |

---

## 11. Files Changed Since Last Review (vs `origin/main`)

```bash
# Staged (new fonts)
public/fonts/inter-cyrillic-400-normal.woff2
public/fonts/inter-cyrillic-500-normal.woff2
public/fonts/inter-cyrillic-600-normal.woff2
public/fonts/inter-cyrillic-700-normal.woff2
public/fonts/inter-latin-400-normal.woff2
public/fonts/inter-latin-500-normal.woff2
public/fonts/inter-latin-600-normal.woff2
public/fonts/inter-latin-700-normal.woff2

# Modified (uncommitted)
CONTEXT.md
README.md
package-lock.json
package.json
public/app.js
public/index.html
public/styles.css
src/server.js
```

**Diff stats:** 16 files, 3769 insertions(+), 3623 deletions(-) — значительная эволюция с последнего коммита.

---

## 12. Consilium Notes for Second Reviewer

Этот ревью провел AI agent (Nemotron 3 Ultra) с полным доступом к репозиторию. Ключевые области, где второе мнение будет ценным:

1. **Email outbox design** — in-process (setImmediate) или отдельный worker process?
2. **LLM provider abstraction** — стоит ли сложность сейчас, или отложить до multi-provider needs?
3. **TypeScript migration strategy** — `checkJs: true` + JSDoc vs full `.ts` rewrite?
4. **Admin circuit scope** — minimal viable admin (list + approve) vs full crop/publish?
5. **Security** — стоит ли magic bytes validation для internal tool?
6. **Shutdown auth** — простой Origin check или токен?
7. **Rate limiting** — нужен ли для localhost single-operator MVP?

Кодовая база хорошо структурирована для своего назначения (local operator tool). Основные риски — операционные (email sync, LLM reliability, data loss) не архитектурные. Документация (`CONTEXT.md`, `OBJECT_SCHEMA.md`) исключительно хороша и должна поддерживаться по мере эволюции проекта.

---

*Report generated by Hermes Agent • MapControl Code Review • 2026-07-05*