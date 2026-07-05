# MapControl — Code Review Report

**Date:** 2026-07-05  
**Reviewer:** Hermes Agent (nvidia/nemotron-3-ultra-550b-a55b:free)  
**Repository:** https://github.com/AlexanderKuzikov/MapControl  
**Commit:** `52cf69a` (main branch, up to date with origin)  
**Scope:** Full codebase analysis — architecture, backend, frontend, data schema, LLM integration, email, deployment, security, testability

---

## Executive Summary

| Metric | Score | Verdict |
|--------|-------|---------|
| **Overall** | **7.5/10** | Strong MVP, ready for operator pilot |
| **Architecture** | 8/10 | Clean, modular, clear separation of concerns |
| **Backend** | 7.5/10 | Good validation, path protection, atomic writes. Missing: rate limiting, async email, LLM timeouts |
| **Frontend** | 8/10 | Modern vanilla JS, excellent UX (diff, paste, EXIF), professional Sky Pro CSS |
| **Data Schema** | 9/10 | Exemplary documentation, clear SSOT vs Buffer separation, audit trail |
| **LLM Integration** | 7/10 | Correct params, response validation. Risk: provider lock-in, no timeouts/retries |
| **Email** | 6/10 | Works but synchronous in critical path — production blocker |
| **Windows Deployment** | 9.5/10 | Gold-standard launcher for local Node apps |
| **Documentation** | 9/10 | README + CONTEXT + OBJECT_SCHEMA — model for pet projects |
| **Testability** | 3/10 | No tests, no TypeScript, no linting, no CI |
| **Security** | 7/10 | Basics covered, missing rate limiting, magic bytes validation |

**Key Blockers for Production:**
1. **Email outbox pattern** (fire-and-forget + retries)
2. **Rate limiting** on LLM and upload endpoints
3. **LLM fetch timeout + retry** (429/5xx handling)

---

## 1. Architecture & Structure

### Repository Layout
```
MapControl/
├── CONTEXT.md              # Living dev context, decisions, roadmap
├── README.md               # Project overview, setup, tech stack
├── OBJECT_SCHEMA.md        # Canonical data specification (SSOT + Submission)
├── CODE_REVIEW_REPORT.md   # This file
├── launcher.js             # Auto-port, health-check, browser open, hidden launch
├── start.vbs               # Hidden launcher entry point (no console)
├── update.bat              # git pull + npm ci, server running check
├── update.vbs              # Hidden update.bat launcher
├── .env.example            # Configuration template
├── public/
│   ├── index.html          # SPA entry point, Sky Pro theme, exit/help dialogs
│   ├── app.js              # Frontend logic (vanilla ES modules)
│   ├── styles.css          # Sky Pro design system, dark/light, local Inter fonts
│   └── fonts/              # 8 woff2 files (latin/cyrillic 400-700)
├── src/
│   ├── server.js           # Express API (single file, ~620 lines)
│   └── prompts/
│       └── check-text.txt  # LLM system prompt
├── scripts/
│   └── create-shortcuts.vbs # Desktop shortcut generator
└── data/
    └── submissions/
        ├── draft/          # Operator drafts
        ├── pending/        # Submitted for admin review
        └── archive/        # Published/rejected
```

### Strengths
- **Clear separation**: API (`src/server.js`) | UI (`public/`) | Launcher (`launcher.js`)
- **File-based storage**: `data/submissions/{draft,pending,archive}/{id}/meta.json + images/` — simple, portable, auditable
- **Minimal dependencies**: express, multer, sharp, nodemailer, zod, exifr, nanoid, dotenv — all current, no bloat
- **Windows-first deployment**: `start.vbs → launcher.js` handles auto-port (5179-5279), `localhost` (critical for Yandex Maps API key), health-check, logging, PID file — best-in-class for local Node apps

---

## 2. Backend Analysis (`src/server.js`)

### Strong Points ✅

| Feature | Why It Matters |
|---------|----------------|
| **Zod validation on all endpoints** (`CreateDraftSchema`, `UpdateDraftSchema`, `CheckTextSchema`, inline in `apply-llm`) | Runtime type safety, clear 400 errors |
| **Path traversal protection** (`assertInsideSubmissions`, `sanitizeId` regex `^[A-Za-z0-9_-]{1,32}$`) | Blocks `../../etc/passwd` attacks |
| **Atomic JSON writes** (`writeJsonAtomic` via `.tmp-<ts>` + `rename`) | No corrupted JSON on crash |
| **EXIF GPS extraction BEFORE sharp** (`exifr.parse(f.buffer)`) | Metadata preserved during resize |
| **Attachment filtering by `meta.images`** (not `readdir`) | Fixes orphan-file accumulation (2026-07-04 fix) |
| **LLM payload tuned for Qwen**: `temp 0.1`, `response_format: json_object`, `chat_template_kwargs: {enable_thinking: false}` | Deterministic, structured output, no reasoning bloat |
| **Fallback `</think>` strip** | Handles providers ignoring `enable_thinking` |
| **Graceful shutdown endpoint** (`POST /api/shutdown`) | Clean UI exit without hung browser |

### Issues & Vulnerabilities ⚠️

| # | Issue | Risk | Fix |
|---|-------|------|-----|
| **1** | **No rate limiting** on `/api/llm/check-text`, `/api/submissions/draft/:id/images` | DoS on LLM API, token budget drain | `express-rate-limit` keyed by IP + `submissionId` |
| **2** | **Synchronous SMTP in `submit`** (line 583) | SMTP timeout (30-60s) → operator waits, possible 504 | **Outbox pattern**: `setImmediate(() => sendEmail().catch(log))`, return 200 immediately |
| **3** | **No timeout on LLM `fetch`** | Hangs indefinitely on provider issues | `AbortController` + `setTimeout(30s)` |
| **4** | **No retries on LLM** (429, 5xx) | Transient provider errors break operator UX | Exponential backoff retry (3 attempts) |
| **5** | `nanoid(10)` — ~64 bits entropy | Collisions unlikely but non-standard | Use `nanoid(21)` or default `nanoid()` |
| **6** | `LLM_BASE_URL` not validated as URL | Cryptic fetch error on bad config | `new URL(LLM_BASE_URL)` at startup |
| **7** | `sharp` without `limitInputPixels` | Malicious TIFF/HEIF can exhaust RAM | `sharp(buf, { limitInputPixels: 268402689 })` (256MP) |
| **8** | No request logging (morgan/pino) | Hard to debug production | Add `pino` + pretty transport for dev |
| **9** | Prompt loaded once at startup | Changing `check-text.txt` requires restart | Hot-reload (`fs.watch`) or `/api/reload-prompt` |
| **10** | `SMTP_SECURE` parsing fragile | `'false'` → `true` edge cases | Whitelist: `['true','1','yes'].includes(v.toLowerCase())` |

### Recommended Improvements 💡

- **Health endpoint** (`/api/health`) — monitoring, docker, launcher checks
- **Request ID** (nanoid) + structured logging — frontend↔backend correlation
- **Unified `SubmissionMeta` Zod schema** — single source of truth (currently scattered across endpoints)
- **Config via Zod** (`envSchema.parse(process.env)`) — fail-fast with clear messages

---

## 3. Frontend Analysis (`public/app.js`, `index.html`, `styles.css`)

### Strong Points ✅

| Feature | Assessment |
|---------|------------|
| **Vanilla ES modules** (`type="module"`) | No bundler, fast, transparent |
| **Sky Pro design system** | CSS variables, dark/light theme, local Inter fonts (woff2, unicode-range) — professional grade |
| **Split button "Check / AI"** | UX pattern for frequent/rare actions |
| **Diff UI** (original vs suggested) | Operator sees exactly what LLM changes |
| **Paste coordinate parsing** (`55.915, 57.870` → auto-split) | Great for copy-paste from maps/Excel |
| **EXIF GPS auto-fill** after photo upload | Reduces manual entry |
| **Exit flow**: confirm → `/api/shutdown` → "Server stopped / Close window" | No hung browser, clean UX |
| **Help overlay** with contextual tips | Onboarding built-in |
| **Dynamic Yandex Maps v3 load** only when API key present | Graceful degradation |

### Issues ⚠️

| # | Issue | Impact |
|---|-------|--------|
| **1** | `state.llmLast` not cleared on draft switch | Data leaks between submissions |
| **2** | `validateBeforeCheck()` requires photos but LLM only checks text | Forced photo upload before text check — extra step |
| **3** | No loading indicators on buttons (only `disabled`) | User doesn't see progress |
| **4** | No draft auto-save | Data loss on browser crash/network failure |
| **5** | `parseNum` doesn't handle spaces in numbers (`55.915 172`) | Minor UX friction |
| **6** | Hardcoded `initialCenter: [56.2285, 58.014746]` (Perm?) | Should come from `.env` or geo-IP |
| **7** | No drag&drop, no photo previews | Upload UX could be smoother |
| **8** | `ymaps3` no cleanup on page reload | Memory leak (minor for SPA) |

### UX Ideas 💡

- Auto-save draft (debounce 2s, localStorage fallback)
- Optimistic UI updates
- Drag&drop + thumbnail grid for photos
- Copy submission JSON button (debugging)
- Toast notifications instead of inline `msg`

---

## 4. Data Schema (`OBJECT_SCHEMA.md`, `meta.json`)

### Excellent Documentation ✅

- **Clear SSOT separation**: `Zavodsvay-Static/data/map.json` (published) vs MapControl submissions (buffer)
- **Full field specs**: types, rules, enums, examples
- **`pileCount` guardrails**: "LLM must not invent — only extract if explicitly stated"
- **Submission audit trail**: `original → llm_suggested → operator_final → admin_final`
- **LLM metadata captured**: provider, model, latency, usage, warnings, confidence

### Code ↔ Schema Gaps ⚠️

| Schema Field | In Code | Status |
|--------------|---------|--------|
| `title_llm_suggested` / `techDescription_llm_suggested` | ❌ Only in `llm` object at apply time | Add at `/check-text` response |
| `title_admin_final` / `techDescription_admin_final` | ❌ Admin UI not built | OK for MVP |
| `category_admin` | ❌ | OK for MVP |
| `rejection_reason` | ❌ | Add for reject flow |
| `published_object_id` | ❌ | Add at publish |
| `images[].cropped_filename` / `notes` | ❌ | For admin cropping |

**Recommendation**: Extract unified `SubmissionMeta` Zod schema to `src/schemas/submission.js` — single source for backend + TypeScript type generation for frontend.

---

## 5. LLM Integration

### Well Configured ✅

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `temperature` | 0.1 | Deterministic output |
| `max_tokens` | 512 | Sufficient for JSON response |
| `response_format` | `{type: 'json_object'}` | Enforced JSON |
| `chat_template_kwargs` | `{enable_thinking: false}` | Disables Qwen reasoning (saves ~70% tokens) |
| Response validation | `LlmOutSchema` (Zod) | Fail-fast on invalid JSON |
| Metadata in response | `_provider`, `_model`, `_latency_ms`, `_usage`, `_prompt_version` | Full observability |
| Fallback cleanup | Strip `` | Handles non-compliant providers |

### Risks ⚠️

| Risk | Details |
|------|---------|
| **Provider lock-in (RouterAI)** | `chat_template_kwargs` is vLLM-specific, not standard OpenAI. Need `buildLlmPayload(provider)` abstraction |
| **No fetch timeout** | Can hang forever — add `AbortController(30s)` |
| **No retries** | 429/5xx = broken UX — need exponential backoff |
| **Prompt hot-reload missing** | Requires server restart |
| **`pileCount_suggested` hallucination risk** | Prompt says "only if explicit" but LLM may guess. Add: "If uncertain, omit field entirely" |

---

## 6. Email / SMTP (`nodemailer` v8)

### Good ✅
- HTML + text multipart
- Attachments filtered by `meta.images` (orphan protection)
- Raw JSON in `<pre>` for admin parsing automation

### Production Blockers ❌

| Issue | Fix |
|-------|-----|
| **Synchronous in `submit`** | Outbox pattern: `setImmediate(() => sendEmail().catch(log))`, return 200 immediately |
| **No retries** | Separate retry process/interval, log status in `meta.email_log[]` |
| **Single recipient** (`MAIL_TO`) | Plan: `MAIL_TO` (queue) + `MAIL_NOTIFY` (personal) — not implemented |

---

## 7. Windows Deployment — **9.5/10**

| Component | Role |
|-----------|------|
| `start.vbs` | Hidden `node launcher.js` launch (no console window) |
| `launcher.js` | Auto-port (5179-5279), `localhost` (Yandex key compat), health-check `/api/config`, browser open, logs to `logs/server.log`, PID file |
| `update.bat` | `git pull` + `npm ci --omit=dev`, checks server stopped (curl 5179) |
| `update.vbs` | Hidden `update.bat` launch |
| `create-shortcuts.vbs` | Generates `MapControl.lnk` + `Update MapControl.lnk` with correct paths/icons |

### Minor Issues
- `update.bat` checks only port 5179 — launcher may use 5180+. Should read `server.pid` or check range.
- `favicon.ico` referenced in shortcut but doesn't exist.
- `logs/server.log` no rotation — add `pino` rotation or daily file rename.

---

## 8. Security Assessment

| Vector | Status | Notes |
|--------|--------|-------|
| Path traversal | ✅ Protected | `assertInsideSubmissions` + `sanitizeId` |
| XSS (email HTML) | ✅ Protected | `escapeHtml` on all user fields |
| XSS (frontend) | ✅ Protected | Only `textContent`/`value`, no `innerHTML` |
| CSRF | ⚠️ N/A | Localhost, no cookies/sessions |
| Rate limiting | ❌ Missing | Add on LLM + upload endpoints |
| File upload validation | ⚠️ Partial | `sharp` metadata + format whitelist, but no magic bytes check |
| Max file size | ✅ Limited | `multer: 30MB, files: 20` |
| Secrets in code | ✅ None | Only `.env` |
| LLM API key in logs | ✅ No | Only model/latency/usage logged |

---

## 9. Testability & Code Quality — **3/10**

| Aspect | Status |
|--------|--------|
| Unit tests | ❌ None |
| Integration tests | ❌ None |
| TypeScript | ❌ Plain JS + JSDoc in schemas |
| ESLint / Prettier | ❌ Not configured |
| CI/CD (GitHub Actions) | ❌ None |
| Error boundaries | ❌ Manual try/catch everywhere |

**Minimum for Production-Ready:**
```bash
npm i -D eslint prettier @types/node typescript vitest
# tsconfig.json with checkJs: true + JSDoc types
# vitest for Zod schemas, utilities (parseNum, sanitizeId, escapeHtml)
# GitHub Action: lint + test + build check
```

---

## 10. Priority Action Items

| Priority | Task | Estimate |
|----------|------|----------|
| 🔥 **P0** | **Email outbox** (fire-and-forget + retries + `meta.email_log[]`) | 2-3h |
| 🔥 **P0** | **Rate limiting** on `/api/llm/check-text` and `/images` | 1h |
| 🔥 **P0** | **LLM fetch timeout + retry** (`AbortController(30s)` + retry 429/5xx) | 1h |
| 🟡 **P1** | **Draft auto-save** (debounce 2s, localStorage fallback) | 3-4h |
| 🟡 **P1** | **Admin circuit** (pending list, view, crop, publish) | 1-2 weeks |
| 🟡 **P1** | **Export to Zavodsvay-Static format** (`map.json` + assets) | 1 week |
| 🟢 **P2** | **TypeScript + tests + CI** (vitest, eslint, GitHub Actions) | 1-2 days |
| 🟢 **P2** | **Drag&drop photos + previews** | 2-3h |
| 🟢 **P2** | **Two email recipients** (`MAIL_TO` + `MAIL_NOTIFY`) | 30 min |
| 🔵 **P3** | **LLM provider abstraction** (`buildLlmPayload(provider)`) | 4-6h |
| 🔵 **P3** | **LLM latency monitoring** (JSON log or Prometheus) | 2h |

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

**Diff stats:** 16 files, 3769 insertions(+), 3623 deletions(-) — significant evolution since last commit.

---

## 12. Consilium Notes for Second Reviewer

This review was conducted by an AI agent (Nemotron 3 Ultra) with full repository access. Key areas where a second opinion would be valuable:

1. **Email outbox design** — should it be in-process (setImmediate) or separate worker process?
2. **LLM provider abstraction** — worth the complexity now, or defer until multi-provider needed?
3. **TypeScript migration strategy** — `checkJs: true` + JSDoc vs full `.ts` rewrite?
4. **Admin circuit scope** — minimal viable admin (list + approve) vs full crop/publish?
5. **Security** — is magic bytes validation worth the complexity for internal tool?

The codebase is well-structured for its purpose (local operator tool). Main risks are operational (email sync, LLM reliability) not architectural. The documentation (`CONTEXT.md`, `OBJECT_SCHEMA.md`) is exceptionally good and should be maintained as the project evolves.

---

*Report generated by Hermes Agent • MapControl Code Review • 2026-07-05*