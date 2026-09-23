// src/site-config.js — настройки сайта (один сайт = одна установка).
// Чтение config/site.json + Zod-валидация, fail-fast на старте с понятной ошибкой.
// Секреты (.env) и пользовательские данные (data/) сюда не входят.
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SITE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'site.json');

const SiteConfigSchema = z.object({
  siteName: z.string().trim().min(1).max(80),
  map: z.object({
    center: z.tuple([
      z.number().finite().min(-90).max(90),
      z.number().finite().min(-180).max(180),
    ]),
    zoom: z.number().int().min(0).max(22),
  }),
  categories: z
    .array(
      z.object({
        value: z.string().trim().min(1).max(40),
        label: z.string().trim().min(1).max(80),
      })
    )
    .min(1)
    .refine(
      (list) => new Set(list.map((c) => c.value)).size === list.length,
      { message: 'categories[].value must be unique' }
    ),
  pileCount: z.object({
    required: z.boolean(),
  }),
  inbox: z
    .object({
      enabled: z.boolean(),
      url: z.string().trim().max(500),
    })
    .default({ enabled: false, url: 'https://zavodsvay.ru/inbox/' })
    .refine(
      (inbox) => !inbox.enabled || /^https?:\/\/.+/.test(inbox.url),
      { message: 'inbox.url must be http(s) URL when inbox.enabled is true' }
    ),
  llm: z.object({
    model: z.string().trim().min(1).max(120),
    promptFile: z.string().trim().min(1).max(255),
  }),
});

function loadSiteConfig() {
  let raw;
  try {
    raw = fs.readFileSync(SITE_CONFIG_PATH, 'utf8');
  } catch (e) {
    console.error(`[MapControl] Не найден конфиг сайта: ${SITE_CONFIG_PATH}`);
    console.error('[MapControl] Скопируйте пример и поправьте под сайт (см. config/site.json).');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[MapControl] Конфиг сайта не JSON: ${SITE_CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }

  const result = SiteConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`[MapControl] Невалидный конфиг сайта: ${SITE_CONFIG_PATH}`);
    for (const issue of result.error.issues) {
      console.error(`[MapControl] config: ${(issue.path || []).join('.') || '(root)'} — ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

const siteConfig = loadSiteConfig();

module.exports = siteConfig;
module.exports.siteConfig = siteConfig;
module.exports.SITE_CONFIG_PATH = SITE_CONFIG_PATH;
