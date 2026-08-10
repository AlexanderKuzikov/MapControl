# MapControl — Instructions for AI Agents

## Commands
- dev: `npm run dev`
- start: `npm start`

## Conventions
- Node.js CommonJS, plain JavaScript (без TypeScript)
- Express 5
- Vanilla HTML/CSS/JS frontend
- Yandex Maps API v3
- LLM: Qwen 3.5 Flash via RouterAI (OpenAI-compatible)
- Sharp для WebP конверсии
- nodemailer для email
- Zod для валидации
- JSON files на диске (data/submissions/)
- Сервер на 127.0.0.1 только

## Structure
- `src/server.js` — Express-сервер
- `public/` — SPA (index.html, styles.css, app.js)
- `data/submissions/` — draft/ + pending/
- `scripts/` — create-shortcuts.vbs
- `launcher.js` — авто-порт + браузер
- `start.vbs` — Windows launcher

## Do NOT touch
- `.env` — секреты (SMTP, LLM keys)
- `data/` — пользовательские данные
- `node_modules/`

## Documentation rules
- После работы — обнови docs/CONTEXT.md
- Если принял архитектурное решение — запиши в docs/DECISIONS.md
- НЕ создавай новых файлов документации без разрешения
- Переиспользуемые знания — в D:\GitHub\knowledge/README.md
