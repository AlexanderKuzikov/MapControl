const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { nanoid } = require('nanoid');
const { z } = require('zod');

const app = express();

const PORT = Number(process.env.PORT || 5179);

const SUBMISSIONS_ROOT = path.resolve(__dirname, '..', 'data', 'submissions');
const DRAFT_DIR = path.join(SUBMISSIONS_ROOT, 'draft');
const PENDING_DIR = path.join(SUBMISSIONS_ROOT, 'pending');
const ARCHIVE_DIR = path.join(SUBMISSIONS_ROOT, 'archive');

const IMAGE_MAX_WIDTH = Number(process.env.IMAGE_MAX_WIDTH || 2048);
const IMAGE_WEBP_QUALITY = Number(process.env.IMAGE_WEBP_QUALITY || 80);

const YANDEX_MAPS_API_KEY = process.env.YANDEX_MAPS_API_KEY || '';
const YANDEX_MAPS_LANG = process.env.YANDEX_MAPS_LANG || 'ru_RU';

const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen/qwen3.5-flash';

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
  const rel = path.relative(SUBMISSIONS_ROOT, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Invalid submission path');
    err.statusCode = 400;
    throw err;
  }
}

const CreateDraftSchema = z.object({
  operatorName: z.string().trim().min(1).max(80).optional(),
});

const UpdateDraftSchema = z.object({
  title: z.string().trim().min(1),
  techDescription: z.string().trim().min(1),
  coords: z.tuple([
    z.number().finite().min(-90).max(90),
    z.number().finite().min(-180).max(180),
  ]),
});

const CheckTextSchema = z.object({
  title: z.string().trim().min(1),
  techDescription: z.string().trim().min(1),
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
    const submissionId = req.params.id;
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
    const submissionId = req.params.id;
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const body = UpdateDraftSchema.parse(req.body);

    meta.updated_at = nowIso();
    meta.coords = body.coords;
    meta.title_original = body.title;
    meta.techDescription_original = body.techDescription;

    // Operator final defaults to original until LLM check / manual edits.
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
    const submissionId = req.params.id;
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    await fsp.mkdir(p.images, { recursive: true });

    const startOrder = (meta.images?.length || 0) + 1;
    const saved = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const order = startOrder + i;
      const filename = `upload_${String(order).padStart(2, '0')}.webp`;
      const outPath = path.join(p.images, filename);
      await assertInsideSubmissions(outPath);

      const img = sharp(f.buffer, { failOn: 'none' });
      const metadata = await img.metadata();
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
      });
    }

    meta.updated_at = nowIso();
    meta.images = [...(meta.images || []), ...saved];
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

    const system = [
      'Ты — редактор контента для сайта завода винтовых свай.',
      'Твоя задача: исправить орфографию/пунктуацию, унифицировать стиль и формат, не добавляя фактов.',
      'Запрещено: выдумывать числа/размеры/количество свай/адреса; менять смысл.',
      'Если данных не хватает — добавь предупреждения warnings[].',
      'Верни СТРОГО JSON без Markdown и без пояснений вокруг.',
      'Схема ответа:',
      '{ "title_suggested": string, "techDescription_suggested": string, "warnings": string[], "confidence": "low"|"medium"|"high", "pileCount_suggested"?: number }',
      'pileCount_suggested указывать только если в тексте явно присутствует количество свай.',
    ].join('\n');

    const user = JSON.stringify({
      title: body.title,
      techDescription: body.techDescription,
    });

    const payload = {
      model: LLM_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };

    const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: 'LLM request failed', status: r.status, details: text.slice(0, 2000) });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      return res.status(502).json({ error: 'LLM response missing content' });
    }

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
      pileCount_suggested: z.number().int().nonnegative().optional(),
    });

    const out = LlmOutSchema.parse({
      warnings: [],
      ...parsed,
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

app.post('/api/submissions/draft/:id/apply-llm', async (req, res, next) => {
  try {
    const submissionId = req.params.id;
    const p = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(p.root);
    const meta = await readJsonIfExists(p.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    const body = z.object({
      title_operator_final: z.string().trim().min(1),
      techDescription_operator_final: z.string().trim().min(1),
      llm: z
        .object({
          provider: z.string().optional(),
          model: z.string().optional(),
          prompt_version: z.string().optional(),
          checked_at: z.string().optional(),
          warnings: z.array(z.string()).optional(),
          confidence: z.enum(['low', 'medium', 'high']).optional(),
          pileCount_suggested: z.number().int().nonnegative().optional(),
        })
        .optional(),
    }).parse(req.body);

    meta.updated_at = nowIso();
    meta.title_operator_final = body.title_operator_final;
    meta.techDescription_operator_final = body.techDescription_operator_final;
    meta.llm = body.llm || meta.llm;

    await writeJsonAtomic(p.meta, meta);
    res.json({ ok: true, meta });
  } catch (e) {
    next(e);
  }
});

app.post('/api/submissions/draft/:id/submit', async (req, res, next) => {
  try {
    const submissionId = req.params.id;
    const draft = submissionPaths(DRAFT_DIR, submissionId);
    await assertInsideSubmissions(draft.root);
    const meta = await readJsonIfExists(draft.meta);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    // All fields required (operator stage)
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

    // Copy images
    const draftImgs = await fsp.readdir(draft.images).catch(() => []);
    for (const f of draftImgs) {
      const src = path.join(draft.images, f);
      const dst = path.join(pending.images, f);
      await fsp.copyFile(src, dst);
    }

    meta.status = 'submitted';
    meta.updated_at = nowIso();
    await writeJsonAtomic(pending.meta, meta);

    // Keep draft for now (audit). Optionally could delete/move later.
    res.json({ ok: true, submissionId });
  } catch (e) {
    next(e);
  }
});

app.use((err, req, res, next) => {
  const status = err?.statusCode || 500;
  const message = err?.message || 'Server error';
  res.status(status).json({ error: message });
});

ensureDirs()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`MapControl running at http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start:', e);
    process.exit(1);
  });

