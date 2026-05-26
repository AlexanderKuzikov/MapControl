# OBJECT_SCHEMA.md — Спецификация данных объекта / Object data specification

> RU: Каноническая спецификация полей объекта (для валидации, UI и LLM-контроля).  
> EN: Canonical object field specification (for validation, UI, and LLM guardrails).

Связанные документы / Related docs:
- `CONTEXT.md` — архитектура, роли, этапы, макеты экранов
- `Zavodsvay-Static/data/map.json` — SSOT опубликованных объектов на сайте

---

## 1) Термины / Terms

- **RU: Объект (Published Object)** — запись в `Zavodsvay-Static/data/map.json`, которая отображается на `/map/` и ведёт на `/objects/{id}/`.  
  **EN:** A record in `Zavodsvay-Static/data/map.json` shown on `/map/` and linking to `/objects/{id}/`.

- **RU: Заявка (Submission)** — промежуточный пакет данных, который создаёт оператор и отправляет администратору. До публикации **не является** частью SSOT.  
  **EN:** A buffered operator-created package sent to admin; **not** part of SSOT until published.

---

## 2) Источник правды / Source of truth

- **RU:** Единственный SSOT опубликованных объектов — `Zavodsvay-Static/data/map.json`.  
  MapControl не создаёт второй реестр опубликованных объектов; он формирует заявки и оркестрирует публикацию в SSOT.

- **EN:** The only SSOT for published objects is `Zavodsvay-Static/data/map.json`.  
  MapControl does not create a second registry; it produces submissions and orchestrates publishing into SSOT.

---

## 3) Схема опубликованного объекта (SSOT) / Published Object schema (SSOT)

Файл / File: `Zavodsvay-Static/data/map.json`  
Формат верхнего уровня / Top-level: `Array<PublishedObject>`

### 3.1 Поля / Fields

Каждый объект — JSON-объект со следующими полями:

#### `id`
- **Type:** `number` (integer, > 0)
- **Required:** yes (в SSOT)
- **Owner:** admin / publisher
- **Purpose (RU):** уникальный идентификатор, используется в URL страницы и в папке изображений.
- **Purpose (EN):** unique identifier used in object page URL and image folder.
- **Rules:**
  - must be unique across all objects
  - recommended assignment on publish: `max(id) + 1`

#### `coords`
- **Type:** `[number, number]` (tuple) = `[latitude, longitude]`
- **Required:** yes
- **Owner:** operator (input) → admin (final)
- **Purpose (RU):** положение маркера на карте.
- **Purpose (EN):** map marker position.
- **Rules:**
  - **Order is `[lat, lng]`** (ymaps3 accepts the same order)
  - `lat ∈ [-90; 90]`, `lng ∈ [-180; 180]`
  - UI: marker and numeric inputs must be kept in sync
  - optional soft-check: “outside typical region” warning (does not block)

#### `category`
- **Type:** `string` (enum)
- **Required:** yes
- **Owner:** admin
- **Allowed values:**
  - `house`, `banya`, `fence`, `commercial`, `industrial`, `water`, `social`, `agro`, `other`
- **Purpose (RU):** цвет/легенда маркеров, фильтр категорий.
- **Purpose (EN):** marker color/legend, category filter.
- **Rules:**
  - must be one of the allowed enum values
  - LLM may suggest, but final choice is admin-only

#### `pileCount`
- **Type:** `number | null` (integer, >= 0)
- **Required:** conditionally (см. Rules)
- **Owner:** admin (final), derived from operator/admin text when available
- **Purpose (RU):** количество используемых свай. Сейчас может напрямую не отображаться, но важно для будущих сценариев (фильтры, статистика, карточки, SEO и т.п.).
- **Purpose (EN):** number of piles used. It may not be rendered today, but it matters for future use (filters, stats, cards, SEO, etc.).
- **Rules:**
  - if present, must be integer ≥ 0
  - **Если в тексте (`techDescription`) явно указано количество свай** (например, “количество 25 шт.” / “25 свай” / “25 шт.” в контексте свай), то `pileCount` **должен быть заполнен этим числом** при публикации.
  - If the text (`techDescription`) explicitly contains the pile count (e.g., “25 piles” / “quantity 25 pcs” in the context of piles), then `pileCount` **must be set to that number** when publishing.
  - LLM may **extract** (not guess) a `pileCount_suggested` value **only if** it is explicitly present in the input text; otherwise it must emit a warning (e.g., “Не указано количество свай”).
  - **LLM must not invent it**.
  - Consistency check (recommended): if `pileCount` is set, and the text also contains an explicit pile count, they must match; otherwise block publish or require manual override with a note.

#### `title`
- **Type:** `string`
- **Required:** yes
- **Owner:** operator (draft) → admin (final)
- **Purpose (RU):** заголовок карточки/страницы, ключевое поле для поиска.
- **Purpose (EN):** card/page title and key search field.
- **Rules (recommended):**
  - not empty; trimmed
  - recommended length: 20–120 chars
  - should contain: object type + locality (settlement/city) + optional district
  - must not contain HTML

#### `techDescription`
- **Type:** `string`
- **Required:** yes (по текущему контракту UI/контента; можно сделать optional в будущем)
- **Owner:** operator (draft) → admin (final)
- **Purpose (RU):** техническое/краткое описание работ; участвует в поиске.
- **Purpose (EN):** short technical description; used for search.
- **Rules (recommended):**
  - trimmed
  - may contain numbers and units; keep them accurate
  - no HTML

#### `images`
- **Type:** `string[]` (array of filenames)
- **Required:** yes (but may be empty `[]`)
- **Owner:** admin (final), operator provides raw uploads
- **Purpose (RU):** список файлов изображений объекта (только имена файлов).
- **Purpose (EN):** object image filenames (names only).
- **Rules:**
  - filenames only (no paths), recommended: `{id}_1.webp`, `{id}_2.webp`, …
  - published assets path: `/assets/img/objects/{id}/{filename}`
  - may be empty; UI may treat “has photos” as priority

#### `url`
- **Type:** `string`
- **Required:** yes for published objects
- **Owner:** admin / publisher
- **Purpose (RU):** ссылка на страницу объекта.
- **Purpose (EN):** link to object page.
- **Rules:**
  - canonical format: `"/objects/{id}/"`
  - non-empty `url` means “published/has page” in current site logic

### 3.2 Пример PublishedObject / Example PublishedObject

```json
{
  "id": 531,
  "coords": [55.9151725, 57.8706878],
  "category": "house",
  "pileCount": 25,
  "title": "Дом из газобетона, д. Мокино, Култаевское с/п",
  "techDescription": "Свая ВСГ-1 89/300, длина 2000 мм, количество 25 шт. Арматура ф 10 на сварку, бетонный ростверк.",
  "images": ["531_1.webp", "531_2.webp"],
  "url": "/objects/531/"
}
```

---

## 4) Схема заявки (в MapControl) / Submission schema (MapControl buffer)

> RU: В заявке хранится максимум информации для контроля, но публикация в SSOT происходит только администратором.  
> EN: Submissions keep enough data for review/audit; publishing to SSOT is admin-only.

Рекомендуемая структура on-disk (обсуждение) / Proposed on-disk layout:

```
data/submissions/
  draft/{submission_id}/
  pending/{submission_id}/
  archive/{submission_id}/
    meta.json
    images/               # webp, full resolution
    images_cropped/       # optional admin outputs
```

### 4.1 `Submission.meta` (логическая модель) / Logical model

#### Идентификаторы и статус / Identifiers & status
- `submission_id`: `string` (uuid/slug)
- `status`: `draft | submitted | in_review | published | rejected`
- `created_at`, `updated_at`: ISO 8601 strings
- `operator`: optional `{ name?: string }`
- `rejection_reason`: optional `string`
- `published_object_id`: optional `number`

#### Данные объекта (в заявке) / Object payload in submission
- `coords`: `[lat, lng]` (same validation rules)
- `title_original`: `string`
- `techDescription_original`: `string`
- `title_llm_suggested`: optional `string`
- `techDescription_llm_suggested`: optional `string`
- `title_operator_final`: `string`
- `techDescription_operator_final`: `string`
- `title_admin_final`: optional `string`
- `techDescription_admin_final`: optional `string`
- `category_admin`: optional enum (set during review)

#### LLM метаданные / LLM metadata
- `llm`: optional object:
  - `provider`: string
  - `model`: string
  - `prompt_version`: string
  - `checked_at`: ISO 8601
  - `warnings`: `string[]`
  - `confidence`: `low | medium | high` (or numeric)

#### Изображения / Images
- `images`: array of:
  - `filename`: `string` (stored under `images/`)
  - `order`: `number` (1..N)
  - `original_format`: optional (`jpg|png|heic|...`)
  - `width`, `height`: optional numbers
  - `cropped_filename`: optional string (under `images_cropped/`)
  - `notes`: optional string

### 4.2 Пример `meta.json` (эскиз) / Example `meta.json` (draft)

```json
{
  "submission_id": "2026-0143",
  "status": "submitted",
  "created_at": "2026-05-26T18:10:00Z",
  "updated_at": "2026-05-26T18:22:00Z",
  "coords": [55.9151725, 57.8706878],
  "title_original": "Дом газобетон д Мокино",
  "techDescription_original": "свая 89 25шт",
  "title_llm_suggested": "Дом из газобетона, д. Мокино, Култаевское с/п",
  "techDescription_llm_suggested": "Свая 89, количество 25 шт. (переформатировано без добавления данных).",
  "title_operator_final": "Дом из газобетона, д. Мокино, Култаевское с/п",
  "techDescription_operator_final": "Свая 89, количество 25 шт.",
  "llm": {
    "provider": "qwen",
    "model": "qwen-3.5-flash",
    "prompt_version": "v1",
    "checked_at": "2026-05-26T18:20:00Z",
    "warnings": ["Рекомендуется уточнить район/посёлок в заголовке."],
    "confidence": "high"
  },
  "images": [
    { "filename": "upload_01.webp", "order": 1 },
    { "filename": "upload_02.webp", "order": 2 }
  ]
}
```

---

## 5) Правила для LLM (контроль качества) / LLM rules (quality guardrails)

### 5.1 Что LLM может делать / What LLM is allowed to do

- **RU:** исправлять орфографию/пунктуацию, унифицировать стиль, приводить текст к шаблону, улучшать читаемость без изменения смысла.  
  **EN:** fix spelling/punctuation, normalize style, format into a template, improve readability without changing meaning.

- **RU:** добавлять предупреждения `warnings[]`, если не хватает данных (“нет населённого пункта”, “нет размеров”).  
  **EN:** add `warnings[]` when information is missing.

- **RU:** предлагать `category_hint` (не обязательное поле; не финальное).  
  **EN:** suggest `category_hint` (non-binding).

### 5.2 Что LLM запрещено / What LLM must NOT do

- **RU:** выдумывать числа, марки свай, размеры, адреса, район, количество свай, материалы.  
  **EN:** invent specs (numbers, pile brands/types, dimensions, address/district, pile count, materials).

- **RU:** менять координаты (даже если распознала географию по тексту).  
  **EN:** change coordinates.

- **RU:** добавлять HTML/разметку в `title`/`techDescription`.  
  **EN:** inject HTML/markup into title/description.

### 5.3 Проверки на стороне UI/админа / UI & admin checks

- подсветка изменённых чисел (если LLM всё же тронула цифры) и требование ручного подтверждения
- лимиты длины текста, trim, запрет пустых строк в заголовке

---

## 6) Примечания / Notes

- **RU:** `pileCount` существует в SSOT, но в текущем UI/карте может не отображаться — не делаем его обязательным на старте.  
  **EN:** `pileCount` exists in SSOT but may not be rendered; keep it optional initially.

- **RU:** Для единообразия стоит закрепить 5–10 эталонных примеров из реального `map.json` и использовать их как «golden set» для тестирования качества LLM.  
  **EN:** Keep 5–10 real `map.json` golden examples to regression-test LLM output quality.

