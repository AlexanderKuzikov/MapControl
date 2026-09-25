const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { createHash } = require('node:crypto');

require('dotenv').config(process.env.MC_ENV_FILE ? { path: process.env.MC_ENV_FILE } : undefined);

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const exifr = require('exifr');
const { nanoid } = require('nanoid');
const { z } = require('zod');

const siteConfig = require('./site-config');

const app = express();

const PORT = Number(process.env.PORT || 5179);

const SUBMISSIONS_ROOT = path.resolve(process.env.MC_DATA_ROOT || path.join(__dirname, '..', 'data', 'submissions'));
const DRAFT_DIR = path.join(SUBMISSIONS_ROOT, 'draft');
const PENDING_DIR = path.join(SUBMISSIONS_ROOT, 'pending');
const ARCHIVE_DIR = path.join(SUBMISSIONS_ROOT, 'archive');

const IMAGE_MAX_WIDTH = Number(process.env.IMAGE_MAX_WIDTH || 2048);
const IMAGE_WEBP_QUALITY = Number(process.env.IMAGE_WEBP_QUALITY || 80);

const YANDEX_MAPS_API_KEY = process.env.YANDEX_MAPS_API_KEY || '';
const YANDEX_MAPS_LANG = process.env.YANDEX_MAPS_LANG || 'ru_RU';

const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || siteConfig.llm.model;

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || '';
const MAIL_TO = process.env.MAIL_TO || '';

// Inbox (PHP-приёмник): адрес — config/site.json → inbox.url, секрет — .env → INBOX_TOKEN.
// INBOX_URL — только тестовый оверрайд адреса (для локального стенда), подразумевает enabled.
const INBOX_TOKEN = process.env.INBOX_TOKEN || '';
const INBOX_URL_OVERRIDE = (process.env.INBOX_URL || '').trim();
const INBOX_TIMEOUT_MS = Number(process.env.INBOX_TIMEOUT_MS || 30000);

function inboxTarget() {
  const cfg = siteConfig.inbox || { enabled: false, url: '' };
  const url = (INBOX_URL_OVERRIDE || cfg.url || '').trim();
  return { enabled: cfg.enabled || Boolean(INBOX_URL_OVERRIDE), url };
}

// Load prompt at startup — edit the file from config (llm.promptFile), restart to apply
const PROMPT_CHECK_TEXT = fs.readFileSync(
  path.resolve(__dirname, '..', siteConfig.llm.promptFile),
  'utf8'
).trim();

const CATEGORY_VALUES = siteConfig.categories.map((c) => c.value);

let mailTransport = null;

function nowIso() {
  return new Date().toISOString();
}

async function ensureDirs() {
  await fsp.mkdir(DRAFT_DIR, { recursive: true });
  await fsp.mkdir(PENDING_DIR, { recursive: true });
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
}

function submissionPaths(statusDir, submissionId) {
  const root = path.join(statusDir, submissionId);
  return {
    root,
    meta: path.join(root, 'meta.json'),
    images: path.join(root, 'images'),
    imagesCropped: path.join(root, 'images_cropped'),
  };
}

async function readJsonIfExists(p) {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

async function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, filePath);
}

async function assertInsideSubmissions(targetPath) {
  const resolved = path.resolve(targetPath);
  const rel = path.relative(SUBMISSIONS_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Invalid submission path');
    err.statusCode = 400;
    throw err;
  }
}

function imageSequence(filename) {
  const match = /^upload_(\d+)\.webp$/.exec(filename || '');
  return match ? Number(match[1]) : 0;
}

function nextImageFilename(images) {
  const used = new Set(images.map((image) => image?.filename));
  let sequence = images.reduce((max, image) => Math.max(max, imageSequence(image?.filename)), 0) + 1;
  let filename = `upload_${String(sequence).padStart(2, '0')}.webp`;
  while (used.has(filename)) {
    sequence += 1;
    filename = `upload_${String(sequence).padStart(2, '0')}.webp`;
  }
  return filename;
}

function reindexImages(images) {
  return (Array.isArray(images) ? images : [])
    .slice()
    .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    .map((image, index) => ({ ...image, order: index + 1 }));
}

async function readGps(buffer) {
  try {
    const data = await exifr.parse(buffer, {
      pick: ['GPSLatitude', 'GPSLongitude'],
      translateValues: true,
      translateKeys: true,
    });
    const lat = Number(data?.latitude);
    const lng = Number(data?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return {
      lat: Number(lat.toFixed(7)),
      lng: Number(lng.toFixed(7)),
    };
  } catch {
    return null;
  }
}

function sanitizeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    const err = new Error('Invalid submission id');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMailTransport() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !MAIL_FROM || !MAIL_TO) {
    const err = new Error('SMTP is not configured (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO)');
    err.statusCode = 500;
    throw err;
  }

  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }

  return mailTransport;
}

async function sendSubmissionEmail(meta, imagesDir) {
  const transporter = getMailTransport();
  const recipients = MAIL_TO.split(',').map((v) => v.trim()).filter(Boolean);

  // Аттачим только фото, перечисленные в meta.images — не читаем всю папку
  const imageFiles = (meta.images || []).map((img) => img.filename);

  const attachments = imageFiles
    .filter((filename) => filename)
    .map((filename) => ({
      filename,
      path: path.join(imagesDir, filename),
      contentType: 'image/webp',
    }));

  const coords = Array.isArray(meta.coords) && meta.coords.length === 2
    ? `${meta.coords[0]}, ${meta.coords[1]}`
    : '\u2014';

  const subjectTitle = (meta.title_operator_final || meta.title_original || '\u041d\u043e\u0432\u0430\u044f \u0437\u0430\u044f\u0432\u043a\u0430').replace(/[\r\n]+/g, ' ').trim();
  const subject = `[${siteConfig.siteName}] ${subjectTitle} \u2014 ${meta.submission_id}`;

  const operatorName = meta?.operator?.name || '\u2014';
  const description = meta.techDescription_operator_final || meta.techDescription_original || '\u2014';
  const rawJson = JSON.stringify(meta, null, 2);

  const text = [
    `${siteConfig.siteName}: \u043d\u043e\u0432\u0430\u044f \u0437\u0430\u044f\u0432\u043a\u0430 ${meta.submission_id}`,
    '',
    `\u041e\u0431\u044a\u0435\u043a\u0442: ${subjectTitle}`,
    `\u041a\u043e\u043e\u0440\u0434\u0438\u043d\u0430\u0442\u044b: ${coords}`,
    `\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435: ${description}`,
    `\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f: ${meta.category || '\u2014'}`,
    `\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e \u0441\u0432\u0430\u0439: ${meta.pileCount != null ? meta.pileCount : '\u2014'}`,
    `\u041e\u043f\u0435\u0440\u0430\u0442\u043e\u0440: ${operatorName}`,
    `\u0421\u043e\u0437\u0434\u0430\u043d\u043e: ${meta.created_at || '\u2014'}`,
    `\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e: ${meta.updated_at || '\u2014'}`,
    `\u0424\u043e\u0442\u043e: ${attachments.length}`,
    '',
    'JSON:',
    rawJson,
  ].join('\n');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;">
      <h2 style="margin:0 0 16px;">${siteConfig.siteName}: \u043d\u043e\u0432\u0430\u044f \u0437\u0430\u044f\u0432\u043a\u0430</h2>
      <p><strong>ID:</strong> ${escapeHtml(meta.submission_id || '\u2014')}</p>
      <p><strong>\u041e\u0431\u044a\u0435\u043a\u0442:</strong> ${escapeHtml(subjectTitle)}</p>
      <p><strong>\u041a\u043e\u043e\u0440\u0434\u0438\u043d\u0430\u0442\u044b:</strong> ${escapeHtml(coords)}</p>
      <p><strong>\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435:</strong><br>${escapeHtml(description).replace(/\n/g, '<br>')}</p>
      <p><strong>\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f:</strong> ${escapeHtml(meta.category || '\u2014')}</p>
      <p><strong>\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e \u0441\u0432\u0430\u0439:</strong> ${meta.pileCount != null ? escapeHtml(String(meta.pileCount)) : '\u2014'}</p>
      <p><strong>\u041e\u043f\u0435\u0440\u0430\u0442\u043e\u0440:</strong> ${escapeHtml(operatorName)}</p>
      <p><strong>\u0421\u043e\u0437\u0434\u0430\u043d\u043e:</strong> ${escapeHtml(meta.created_at || '\u2014')}</p>
      <p><strong>\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e:</strong> ${escapeHtml(meta.updated_at || '\u2014')}</p>
      <p><strong>\u0424\u043e\u0442\u043e:</strong> ${attachments.length}</p>
      <hr style="margin:20px 0;border:none;border-top:1px solid #ddd;">
      <p><strong>JSON:</strong></p>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border:1px solid #d0d7de;padding:12px;border-radius:6px;">${escapeHtml(rawJson)}</pre>
    </div>
  `;

  await transporter.sendMail({
    from: MAIL_FROM,
    to: recipients,
    subject,
    text,
    html,
    attachments,
  });
}

// POST пакета в PHP-приёмник: meta = JSON меты, images = файлы из meta.images,
// токен в X-Inbox-Token, таймаут INBOX_TIMEOUT_MS. Возвращает { status, body }.
async function postSubmissionToInbox(inboxUrl, meta, imagesDir) {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));

  const imageFiles = (meta.images || []).map((img) => img.filename).filter(Boolean);
  for (const filename of imageFiles) {
    const data = await fsp.readFile(path.join(imagesDir, filename));
    form.append('images', new Blob([data], { type: 'image/webp' }), filename);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INBOX_TIMEOUT_MS);
  try {
    const r = await fetch(inboxUrl, {
      method: 'POST',
      headers: { 'X-Inbox-Token': INBOX_TOKEN },
      body: form,
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    return { status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const CreateDraftSchema = z.object({
  operatorName: z.string().trim().min(1).max(80).optional(),
});

const UpdateDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  techDescription: z.string().trim().min(1).max(2000),
  coords: z.tuple([
    z.number().finite().min(-90).max(90),
    z.number().finite().min(-180).max(180),
  ]),
});

const CheckTextSchema = z.object({
  title: z.string().trim().min(1).max(200),
  techDescription: z.string().trim().min(1).max(2000),
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/assets', express.static(path.resolve(__dirname, '..', 'public'), { fallthrough: true }));
app.use('/', express.static(path.resolve(__dirname, '..', 'public'), { fallthrough: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 20,
    fileSize: 30 * 1024 * 1024,
  },
});

app.get('/api/config', (req, res) => {
  res.json({
    siteName: siteConfig.siteName,
    categories: siteConfig.categories,
    mapCenter: siteConfig.map.center,
    mapZoom: siteConfig.map.zoom,
    pileCount: siteConfig.pileCount,
    yandexMaps: {
      apiKey: YANDEX_MAPS_API_KEY ? 'present' : 'missing',
      lang: YANDEX_MAPS_LANG,
    },
    limits: {
      imageMaxWidth: IMAGE_MAX_WIDTH,
      imageWebpQuality: IMAGE_WEBP_QUALITY,
    },
  });
});

app.get('/api/yandex-maps-script', (req, res) => {
  if (!YANDEX_MAPS_API_KEY) {
    res.status(500).type('text/plain').send('YANDEX_MAPS_API_KEY is missing');
    return;
  }
  const url = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(YANDEX_MAPS_API_KEY)}&lang=${encodeURIComponent(YANDEX_MAPS_LANG)}`;
  res.json({ url });
});

app.post('/api/submissions/draft', async (req, res, next) => {
  try {
    const body = CreateDraftSchema.parse(req.body || {});
    const submissionId = nanoid(10);

    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    await fsp.mkdir(p.images, { recursive: true });
    await fsp.mkdir(p.imagesCropped, { recursive: true });

    const meta = {
      submission_id: submissionId,
      status: 'draft',
      created_at: nowIso(),
      updated_at: nowIso(),
      operator: body.operatorName ? { name: body.operatorName } : undefined,
      coords: null,
      title_original: '',
      techDescription_original: '',
      title_operator_final: '',
      techDescription_operator_final: '',
      category: null,
      pileCount: null,
      llm: null,
      images: [],
    };

    await writeJsonAtomic(p.meta, meta);
    res.json({ submissionId });
  } catch (e) {
    next(e);
  }
});

app.get('/api/submissions/draft/:id', async (req, res, next) => {
  try {
    const submissionId = sanitizeId(req.params.id);
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });
    res.json({ meta });
  } catch (e) {
    next(e);
  }
});

app.post('/api/submissions/draft/:id/update', async (req, res, next) => {
  try {
    const submissionId = sanitizeId(req.params.id);
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const body = UpdateDraftSchema.parse(req.body);

    meta.updated_at = nowIso();
    meta.coords = body.coords;
    meta.title_original = body.title;
    meta.techDescription_original = body.techDescription;

    if (!meta.title_operator_final) meta.title_operator_final = body.title;
    if (!meta.techDescription_operator_final) meta.techDescription_operator_final = body.techDescription;

    await writeJsonAtomic(p.meta, meta);
    res.json({ ok: true, meta });
  } catch (e) {
    next(e);
  }
});

app.post('/api/submissions/draft/:id/images', upload.array('images', 20), async (req, res, next) => {
  try {
    const submissionId = sanitizeId(req.params.id);
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    await fsp.mkdir(p.images, { recursive: true });

    const existingImages = Array.isArray(meta.images) ? meta.images : [];
    const imageHashes = new Map();
    for (const image of existingImages) {
      if (typeof image?.sha256 === 'string' && image.sha256 && typeof image.filename === 'string') {
        if (!imageHashes.has(image.sha256)) imageHashes.set(image.sha256, image.filename);
      }
    }

    const saved = [];
    const duplicates = [];
    let gpsFromPhoto = null;

    for (const f of files) {
      const sha256 = createHash('sha256').update(f.buffer).digest('hex');
      const duplicateFilename = imageHashes.get(sha256);
      if (duplicateFilename) {
        duplicates.push(duplicateFilename);
        continue;
      }

      const gps = await readGps(f.buffer);
      if (gps && !gpsFromPhoto) gpsFromPhoto = gps;

      const allowedFormats = ['jpeg', 'png', 'webp', 'avif', 'heif', 'tiff'];
      const img = sharp(f.buffer, { failOn: 'truncated', limitInputPixels: 268402689 });
      const metadata = await img.metadata();
      if (!allowedFormats.includes(metadata.format)) {
        return res.status(400).json({ error: `Unsupported image format: ${metadata.format}` });
      }

      const filename = nextImageFilename([...existingImages, ...saved]);
      const order = existingImages.length + saved.length + 1;
      const outPath = path.join(p.images, filename);
      await assertInsideSubmissions(outPath);

      const resized = img.resize({
        width: IMAGE_MAX_WIDTH,
        withoutEnlargement: true,
      });

      await resized.webp({ quality: IMAGE_WEBP_QUALITY }).toFile(outPath);

      saved.push({
        filename,
        order,
        original_format: f.mimetype,
        width: metadata.width || null,
        height: metadata.height || null,
        sha256,
        gps,
      });
      imageHashes.set(sha256, filename);
    }

    meta.updated_at = nowIso();
    meta.images = [...existingImages, ...saved];
    await writeJsonAtomic(p.meta, meta);

    res.json({ ok: true, images: meta.images, gps: gpsFromPhoto, duplicates });
  } catch (e) {
    next(e);
  }
});

app.get('/api/submissions/draft/:id/images/:filename', async (req, res, next) => {
  try {
    const submissionId = sanitizeId(req.params.id);
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const images = Array.isArray(meta.images) ? meta.images : [];
    const image = images.find((item) => item?.filename === req.params.filename);
    if (!image) return res.status(404).json({ error: 'Image not found' });

    const imagePath = path.join(p.images, image.filename);
    await assertInsideSubmissions(imagePath);
    try {
      await fsp.access(imagePath);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'Image file not found' });
      throw e;
    }

    res.set('Content-Type', 'image/webp');
    return res.sendFile(imagePath);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/submissions/draft/:id/images/:filename', async (req, res, next) => {
  try {
    const submissionId = sanitizeId(req.params.id);
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const images = Array.isArray(meta.images) ? meta.images : [];
    const imageIndex = images.findIndex((item) => item?.filename === req.params.filename);
    if (imageIndex < 0) return res.status(404).json({ error: 'Image not found' });

    const image = images[imageIndex];
    // Файл на диске НЕ трогаем: удаление — только из списка заявки.
    // Сироты безвредны: submit и письмо берут строго meta.images.
    // Плюс: ошибочно убранное фото можно вернуть повторной заливкой (хеша в мете уже нет).
    const imagePath = path.join(p.images, image.filename);
    await assertInsideSubmissions(imagePath);

    images.splice(imageIndex, 1);
    meta.images = reindexImages(images);
    meta.updated_at = nowIso();
    await writeJsonAtomic(p.meta, meta);

    res.json({ ok: true, images: meta.images });
  } catch (e) {
    next(e);
  }
});

app.post('/api/llm/check-text', async (req, res, next) => {
  try {
    if (!LLM_BASE_URL || !LLM_API_KEY) {
      return res.status(500).json({ error: 'LLM is not configured (LLM_BASE_URL/LLM_API_KEY missing)' });
    }

    const body = CheckTextSchema.parse(req.body);

    const user = JSON.stringify({
      title: body.title,
      techDescription: body.techDescription,
    });

    const payload = {
      model: LLM_MODEL,
      temperature: 0.1,
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT_CHECK_TEXT },
        { role: 'user', content: user },
      ],
    };

    const t0 = Date.now();

    const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const latencyMs = Date.now() - t0;

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error(`[LLM] ${LLM_MODEL} error ${r.status} after ${latencyMs}ms`);
      return res.status(502).json({ error: 'LLM request failed', status: r.status, details: text.slice(0, 2000) });
    }

    const data = await r.json();
    const usage = data?.usage || null;

    console.log(`[LLM] ${LLM_MODEL} ${latencyMs}ms in=${usage?.prompt_tokens ?? '?'} out=${usage?.completion_tokens ?? '?'}`);

    let content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      return res.status(502).json({ error: 'LLM response missing content' });
    }

    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(502).json({ error: 'LLM returned non-JSON content', content: content.slice(0, 2000) });
    }

    const LlmOutSchema = z.object({
      title_suggested: z.string().min(1),
      techDescription_suggested: z.string().min(1),
      warnings: z.array(z.string()).default([]),
      confidence: z.enum(['low', 'medium', 'high']),
      category_suggested: z.enum(CATEGORY_VALUES).default('other'),
      pileCount_suggested: z.number().int().nonnegative().optional(),
    });

    const out = LlmOutSchema.parse({
      warnings: [],
      ...parsed,
    });

    out._provider = 'openai-compatible';
    out._base_url = LLM_BASE_URL;
    out._model = LLM_MODEL;
    out._prompt_version = 'v1';
    out._latency_ms = latencyMs;
    out._usage = usage;

    res.json(out);
  } catch (e) {
    next(e);
  }
});

app.post('/api/submissions/draft/:id/apply-llm', async (req, res, next) => {
  try {
    const submissionId = sanitizeId(req.params.id);
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const body = z.object({
      title_operator_final: z.string().trim().min(1),
      techDescription_operator_final: z.string().trim().min(1),
      category: z.enum(CATEGORY_VALUES).nullable().optional(),
      pileCount: z.number().int().positive().nullable().optional(),
      llm: z
        .object({
          provider: z.string().optional(),
          model: z.string().optional(),
          base_url: z.string().nullable().optional(),
          prompt_version: z.string().optional(),
          checked_at: z.string().optional(),
          latency_ms: z.number().nullable().optional(),
          usage: z.any().optional(),
          warnings: z.array(z.string()).optional(),
          confidence: z.enum(['low', 'medium', 'high']).optional(),
          category_suggested: z.enum(CATEGORY_VALUES).optional(),
          pileCount_suggested: z.number().int().nonnegative().optional(),
        })
        .optional(),
    }).parse(req.body);

    meta.updated_at = nowIso();
    meta.title_operator_final = body.title_operator_final;
    meta.techDescription_operator_final = body.techDescription_operator_final;
    if (body.category !== undefined) meta.category = body.category;
    if (body.pileCount !== undefined) meta.pileCount = body.pileCount;
    meta.llm = body.llm || meta.llm;

    await writeJsonAtomic(p.meta, meta);
    res.json({ ok: true, meta });
  } catch (e) {
    next(e);
  }
});

app.post('/api/submissions/draft/:id/submit', async (req, res, next) => {
  try {
    const submissionId = sanitizeId(req.params.id);
    const draft = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(draft.root);
    const meta = await readJsonIfExists(draft.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const errors = [];
    if (!meta.title_operator_final?.trim()) errors.push('title');
    if (!meta.techDescription_operator_final?.trim()) errors.push('techDescription');
    if (!Array.isArray(meta.coords) || meta.coords.length !== 2) errors.push('coords');
    if (!Array.isArray(meta.images) || meta.images.length < 1) errors.push('images');
    if (!meta.llm) errors.push('llm_check');

    if (errors.length) {
      return res.status(400).json({ error: 'Missing required fields', missing: errors });
    }

    const pending = submissionPaths(PENDING_DIR, submissionId);
    await assertInsideSubmissions(pending.root);
    await fsp.mkdir(pending.root, { recursive: true });
    await fsp.mkdir(pending.images, { recursive: true });
    await fsp.mkdir(pending.imagesCropped, { recursive: true });

    // Копируем только фото из meta.images (не все файлы из папки)
    const imagesToCopy = (meta.images || []).map((img) => img.filename).filter(Boolean);
    for (const f of imagesToCopy) {
      const src = path.join(draft.images, f);
      const dst = path.join(pending.images, f);
      try { await fsp.copyFile(src, dst); } catch (_) { /* файл мог быть удалён */ }
    }

    meta.status = 'submitted';
    meta.updated_at = nowIso();
    await writeJsonAtomic(pending.meta, meta);

    const inbox = inboxTarget();

    // Приёмник выключен — старый путь: только письмо
    if (!inbox.enabled || !inbox.url) {
      await sendSubmissionEmail(meta, pending.images);
      meta.submitted_via = 'email';
      meta.updated_at = nowIso();
      await writeJsonAtomic(pending.meta, meta);
      return res.json({ ok: true, submissionId, via: 'email' });
    }

    if (!INBOX_TOKEN) {
      const err = new Error('INBOX_TOKEN is not configured (проверь INBOX_TOKEN)');
      err.statusCode = 500;
      throw err;
    }

    let inboxRes;
    try {
      inboxRes = await postSubmissionToInbox(inbox.url, meta, pending.images);
    } catch (e) {
      // Сеть/таймаут — fallback письмом
      console.error(`[MapControl] Inbox unreachable (${e.message}), fallback to email`);
      await sendSubmissionEmail(meta, pending.images);
      meta.submitted_via = 'email_fallback';
      meta.updated_at = nowIso();
      await writeJsonAtomic(pending.meta, meta);
      return res.json({ ok: true, submissionId, via: 'email_fallback' });
    }

    // 200 — принято, 409 — уже было принято раньше (идемпотентность на стороне приёмника)
    if (inboxRes.status === 200 || inboxRes.status === 409) {
      meta.submitted_via = 'inbox';
      meta.inbox_notified = inboxRes.body?.notify_sent ?? null;
      meta.updated_at = nowIso();
      await writeJsonAtomic(pending.meta, meta);
      return res.json({ ok: true, submissionId, via: 'inbox', inbox_notified: meta.inbox_notified });
    }

    // Токен чинить руками, а не спамить письмами — без fallback
    if (inboxRes.status === 401 || inboxRes.status === 403) {
      const err = new Error('Приёмник отклонил токен (проверь INBOX_TOKEN)');
      err.statusCode = 502;
      throw err;
    }

    // 5xx — fallback письмом
    if (inboxRes.status >= 500) {
      console.error(`[MapControl] Inbox HTTP ${inboxRes.status}, fallback to email`);
      await sendSubmissionEmail(meta, pending.images);
      meta.submitted_via = 'email_fallback';
      meta.updated_at = nowIso();
      await writeJsonAtomic(pending.meta, meta);
      return res.json({ ok: true, submissionId, via: 'email_fallback' });
    }

    // 400 и прочие 4xx — данные чинить руками, без fallback
    const err = new Error(
      inboxRes.body?.error
        ? `Приёмник отклонил заявку: ${inboxRes.body.error}`
        : `Приёмник вернул HTTP ${inboxRes.status}`
    );
    err.statusCode = 502;
    throw err;
  } catch (e) {
    next(e);
  }
});

function isLocalOrigin(req) {
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

// Shutdown endpoint — called by UI "Exit" button
app.post('/api/shutdown', (req, res) => {
  if (!isLocalOrigin(req)) {
    return res.status(403).json({ error: 'Forbidden: shutdown allowed only from localhost page' });
  }
  res.json({ ok: true });
  console.log('[MapControl] Shutdown requested via UI');
  setTimeout(() => process.exit(0), 500);
});

app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation error', issues: err.errors });
  }
  const status = err?.statusCode || 500;
  const message = err?.message || 'Server error';
  res.status(status).json({ error: message });
});

if (LLM_BASE_URL) {
  try {
    const u = new URL(LLM_BASE_URL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${u.protocol}"`);
    }
  } catch (e) {
    console.error(`Invalid LLM_BASE_URL: "${LLM_BASE_URL}" — должен быть http(s) URL (пример: https://routerai.ru/api/v1): ${e.message}`);
    process.exit(1);
  }
}

ensureDirs()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MapControl running at http://localhost:${PORT}`);
      console.log(`LLM: ${LLM_MODEL} @ ${LLM_BASE_URL} | prompt: ${path.basename(siteConfig.llm.promptFile)} (${PROMPT_CHECK_TEXT.length} chars)`);
      const inboxLog = inboxTarget();
      console.log(`Inbox: ${(inboxLog.enabled && inboxLog.url) || 'disabled'} token=${INBOX_TOKEN ? 'present' : 'missing'}`);
      console.log(`SMTP: ${SMTP_HOST || 'not configured'}:${SMTP_PORT} secure=${SMTP_SECURE} from=${MAIL_FROM || '\u2014'} to=${MAIL_TO || '\u2014'}`);
    });
  })
  .catch((e) => {
    console.error('Failed to start:', e);
    process.exit(1);
  });
