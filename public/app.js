const AUTOSAVE_DELAY_MS = 2000;

let state = {
  submissionId: null,
  llmLast: null,
  photosUploaded: 0,
  photoImages: [],
  ymap: { ready: false },
  autosaveTimer: null,
  autosavePending: false,
  ensureDraftPromise: null,
  draftWritePromise: null,
  llmChecking: false,
  applyingSuggested: false,
  submitting: false,
};

const el = (id) => document.getElementById(id);

function setMsg(text, kind = 'ok') {
  const box = el('msg');
  box.className = 'msg ' + (kind === 'ok' ? 'msg__ok' : 'msg__bad');
  box.textContent = text;
}

function setAutosaveStatus(text) {
  el('autosaveStatus').textContent = text;
}

function getSaveTime() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function getTextFields() {
  return {
    title: el('title').value,
    techDescription: el('desc').value,
    lat: el('lat').value,
    lng: el('lng').value,
  };
}

function hasTextFields(fields) {
  return Object.values(fields).some((value) => value.trim());
}

function parseNum(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clearCoordinateFields() {
  if (state.applyingSuggested || state.submitting) return;
  el('lat').value = '';
  el('lng').value = '';
  if (state.ymap.clearCoords) state.ymap.clearCoords();
  scheduleAutosave();
}

function getForm() {
  const title = el('title').value.trim();
  const techDescription = el('desc').value.trim();
  const lat = parseNum(el('lat').value);
  const lng = parseNum(el('lng').value);
  const coords = lat != null && lng != null ? [lat, lng] : null;
  const images = el('images').files ? Array.from(el('images').files) : [];
  const category = el('category').value || null;
  const pileCount = el('pileCount').value ? Number(el('pileCount').value) : null;
  return { title, techDescription, coords, images, category, pileCount };
}

function validateBeforeCheck() {
  const { title, techDescription, coords, images } = getForm();
  const missing = [];
  if (!title) missing.push('Заголовок');
  if (!techDescription) missing.push('Описание');
  if (!coords) missing.push('Координаты');
  if (!images.length && !state.photosUploaded) missing.push('Фото (минимум 1)');
  return missing;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const msg = json?.error ? json.error : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.details = json;
    throw err;
  }
  return json;
}

async function ensureDraft({ quiet = false } = {}) {
  if (state.submissionId) return state.submissionId;
  if (!state.ensureDraftPromise) {
    state.ensureDraftPromise = api('/api/submissions/draft', { method: 'POST', body: JSON.stringify({}) })
      .then(({ submissionId }) => {
        state.submissionId = submissionId;
        state.llmLast = null;
        state.photosUploaded = 0;
        state.photoImages = [];
        if (!quiet) setMsg('Черновик создан', 'ok');
        return submissionId;
      })
      .finally(() => {
        state.ensureDraftPromise = null;
      });
  }
  return state.ensureDraftPromise;
}

async function queueDraftWrite(operation) {
  const previous = state.draftWritePromise || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  state.draftWritePromise = current;
  try {
    return await current;
  } finally {
    if (state.draftWritePromise === current) state.draftWritePromise = null;
  }
}

async function persistDraft(payload, quiet) {
  return queueDraftWrite(async () => {
    const id = await ensureDraft({ quiet });
    await api(`/api/submissions/draft/${id}/update`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  });
}

function cancelAutosave() {
  if (state.autosaveTimer !== null) clearTimeout(state.autosaveTimer);
  state.autosaveTimer = null;
  state.autosavePending = false;
}

async function runAutosave(fields, rethrow = false) {
  if (state.llmChecking || state.applyingSuggested || state.submitting) return;

  const title = fields.title.trim();
  const techDescription = fields.techDescription.trim();
  const lat = parseNum(fields.lat);
  const lng = parseNum(fields.lng);
  const coords = lat !== null && lng !== null ? [lat, lng] : null;
  if (!title || !techDescription || !coords) return;

  try {
    await persistDraft({ title, techDescription, coords }, true);
    setAutosaveStatus(`Сохранено ${getSaveTime()}`);
  } catch (e) {
    setAutosaveStatus('Не сохранено, попробую позже');
    if (rethrow) throw e;
  }
}

function scheduleAutosave() {
  cancelAutosave();
  const fields = getTextFields();
  if (!hasTextFields(fields)) {
    setAutosaveStatus('');
    return;
  }

  setAutosaveStatus('');
  state.autosavePending = true;
  if (state.applyingSuggested || state.submitting) return;
  if (state.llmChecking) return;

  state.autosaveTimer = setTimeout(() => {
    state.autosaveTimer = null;
    state.autosavePending = false;
    runAutosave(fields);
  }, AUTOSAVE_DELAY_MS);
}

async function saveDraft() {
  cancelAutosave();
  const { title, techDescription, coords } = getForm();
  if (!title || !techDescription || !coords) {
    setMsg('Чтобы сохранить черновик, заполните заголовок, описание и координаты.', 'bad');
    return;
  }
  await persistDraft({ title, techDescription, coords }, false);
  setAutosaveStatus(`Сохранено ${getSaveTime()}`);
  setMsg('Черновик сохранён.', 'ok');
}

function getPhotoGps(image) {
  const lat = Number(image?.gps?.lat);
  const lng = Number(image?.gps?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function updateImagesInfo() {
  const count = Array.isArray(state.photoImages) ? state.photoImages.length : 0;
  el('imagesInfo').textContent = count ? `Загружено: ${count} (обработано в WebP)` : 'файлы не выбраны';
}

function renderPhotoList() {
  const list = el('photoList');
  list.replaceChildren();
  const images = Array.isArray(state.photoImages) ? state.photoImages : [];

  images.forEach((image, index) => {
    const filename = typeof image?.filename === 'string' ? image.filename : '';
    if (!filename) return;

    const order = Number.isInteger(Number(image.order)) ? Number(image.order) : index + 1;
    const item = document.createElement('div');
    item.className = 'photo-item';
    item.setAttribute('role', 'listitem');

    const preview = document.createElement('img');
    preview.className = 'photo-item__preview';
    preview.src = `/api/submissions/draft/${encodeURIComponent(state.submissionId)}/images/${encodeURIComponent(filename)}`;
    preview.alt = `Фото ${order}`;
    preview.loading = 'lazy';
    preview.decoding = 'async';

    const name = document.createElement('span');
    name.className = 'photo-item__name';
    name.textContent = `${order}. ${filename}`;

    const actions = document.createElement('div');
    actions.className = 'photo-item__actions';

    const gpsButton = document.createElement('button');
    gpsButton.type = 'button';
    gpsButton.className = 'photo-item__action photo-item__action--gps';
    gpsButton.textContent = '📍';
    gpsButton.title = 'Вписать координаты из фото';
    gpsButton.setAttribute('aria-label', `Вписать координаты из фото ${order}`);
    gpsButton.addEventListener('click', () => setCoordsFromPhoto(image));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'photo-item__action photo-item__action--delete';
    deleteButton.textContent = '✕';
    deleteButton.title = 'Удалить фото';
    deleteButton.setAttribute('aria-label', `Удалить фото ${order}`);
    deleteButton.addEventListener('click', () => deletePhoto(image));

    if (getPhotoGps(image)) actions.appendChild(gpsButton);
    actions.appendChild(deleteButton);
    item.append(preview, name, actions);
    list.appendChild(item);
  });
}

function setCoordsFromPhoto(image) {
  if (state.applyingSuggested || state.submitting) return;
  const gps = getPhotoGps(image);
  if (!gps) return;

  el('lat').value = String(gps.lat);
  el('lng').value = String(gps.lng);
  if (state.ymap.ready && state.ymap.setCoords) {
    state.ymap.setCoords(gps.lat, gps.lng);
  } else {
    scheduleAutosave();
  }
  setMsg(`Координаты получены из фото: ${gps.lat}, ${gps.lng}`, 'ok');
}

async function deletePhoto(image) {
  const filename = typeof image?.filename === 'string' ? image.filename : '';
  if (!state.submissionId || !filename) return;

  try {
    const json = await queueDraftWrite(() => api(
      `/api/submissions/draft/${state.submissionId}/images/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    ));
    state.photoImages = Array.isArray(json.images) ? json.images : [];
    state.photosUploaded = state.photoImages.length;
    renderPhotoList();
    updateImagesInfo();
    setMsg('Фото удалено.', 'ok');
  } catch (e) {
    setMsg(`Ошибка удаления фото: ${e.message}`, 'bad');
  }
}

async function uploadImages() {
  const { images } = getForm();
  if (!images.length) {
    setMsg('Добавьте хотя бы одно фото.', 'bad');
    return;
  }
  const id = await ensureDraft();
  const fd = new FormData();
  images.forEach((f) => fd.append('images', f, f.name));
  const { res, json } = await queueDraftWrite(async () => {
    const response = await fetch(`/api/submissions/draft/${id}/images`, { method: 'POST', body: fd });
    const body = await response.json().catch(() => null);
    return { res: response, json: body };
  });
  if (!res.ok) {
    throw new Error(json?.error || `Upload failed (HTTP ${res.status})`);
  }

  state.photoImages = Array.isArray(json.images) ? json.images : [];
  state.photosUploaded = state.photoImages.length;
  renderPhotoList();
  updateImagesInfo();
  setInputFiles([]);

  const duplicateCount = Array.isArray(json.duplicates) ? json.duplicates.length : 0;
  const duplicateMessage = duplicateCount ? `Пропущено дублей: ${duplicateCount}` : '';

  if (json.gps) {
    const gps = `${json.gps.lat}, ${json.gps.lng}`;
    let gpsMessage;
    if (!el('lat').value && !el('lng').value) {
      el('lat').value = String(json.gps.lat);
      el('lng').value = String(json.gps.lng);
      if (state.ymap.ready && state.ymap.setCoords) {
        state.ymap.setCoords(json.gps.lat, json.gps.lng);
      }
      gpsMessage = `Координаты получены из фото: ${gps}`;
    } else {
      gpsMessage = `Координаты из фото: ${gps}. Поля уже заполнены, оставлено как было.`;
    }
    setMsg([gpsMessage, duplicateMessage].filter(Boolean).join('; '), 'ok');
    scheduleAutosave();
  } else if (duplicateMessage) {
    setMsg(duplicateMessage, 'ok');
  }
}

function setInputFiles(files) {
  const transfer = new DataTransfer();
  Array.from(files).forEach((file) => transfer.items.add(file));
  el('images').files = transfer.files;
}

async function handleImageSelection(files) {
  if (state.applyingSuggested || state.submitting) return;
  setInputFiles(files || el('images').files);
  const { images } = getForm();
  el('imagesInfo').textContent = images.length ? `Выбрано файлов: ${images.length}` : 'файлы не выбраны';
  if (!images.length) return;
  try {
    await uploadImages();
  } catch (e) {
    setMsg(`Ошибка загрузки: ${e.message}`, 'bad');
  }
}

function renderDiff(original, suggested) {
  el('diffOriginal').textContent = original;
  el('diffSuggested').textContent = suggested;
}

function renderWarnings(warnings) {
  const ul = el('llmWarnings');
  ul.innerHTML = '';
  (warnings || []).forEach((w) => {
    const li = document.createElement('li');
    li.textContent = w;
    ul.appendChild(li);
  });
}

function resetLlmUI() {
  el('llmMeta').textContent = '';
  el('btnApplySuggested').disabled = true;
  el('btnKeepMine').disabled = true;
  el('btnCheck').disabled = false;
}

function startNewApplication() {
  if (
    state.llmChecking ||
    state.applyingSuggested ||
    state.submitting ||
    state.ensureDraftPromise ||
    state.draftWritePromise
  ) return;

  cancelAutosave();
  el('title').value = '';
  el('desc').value = '';
  el('lat').value = '';
  el('lng').value = '';
  el('category').value = '';
  el('pileCount').value = '';
  setInputFiles([]);

  state.submissionId = null;
  state.llmLast = null;
  state.photosUploaded = 0;
  state.photoImages = [];

  renderPhotoList();
  updateImagesInfo();
  renderDiff('', '');
  renderWarnings([]);
  resetLlmUI();
  el('btnSubmit').disabled = true;
  if (state.ymap.clearCoords) state.ymap.clearCoords();

  setAutosaveStatus('');
  setMsg('Новая заявка', 'ok');
}

async function checkLLM() {
  if (state.applyingSuggested || state.submitting) return;
  const missing = validateBeforeCheck();
  if (missing.length) {
    setMsg(`Заполните обязательные поля: ${missing.join(', ')}.`, 'bad');
    return;
  }

  el('btnCheck').disabled = true;
  el('btnApplySuggested').disabled = true;
  el('btnKeepMine').disabled = true;
  el('btnSubmit').disabled = true;
  state.llmChecking = true;

  try {
    await saveDraft();
    // Файлы уже уехали при выборе (handleImageSelection); повторно не шлём.
    if (getForm().images.length) await uploadImages();

    const { title, techDescription } = getForm();
    renderDiff(`${title}\n\n${techDescription}`, '…');
    renderWarnings([]);
    el('llmMeta').textContent = 'Проверяем…';

    const out = await api('/api/llm/check-text', {
      method: 'POST',
      body: JSON.stringify({ title, techDescription }),
    });
    state.llmLast = out;

    const suggested = `${out.title_suggested}\n\n${out.techDescription_suggested}`;
    renderDiff(`${title}\n\n${techDescription}`, suggested);
    renderWarnings(out.warnings || []);

    if (out.category_suggested) {
      el('category').value = out.category_suggested;
    }
    if (out.pileCount_suggested != null) {
      el('pileCount').value = String(out.pileCount_suggested);
    }

    const metaParts = [`confidence: ${out.confidence}`];
    if (out.category_suggested) metaParts.push(`category: ${out.category_suggested}`);
    if (out.pileCount_suggested != null) metaParts.push(`piles: ${out.pileCount_suggested}`);
    if (out._latency_ms != null) metaParts.push(`${out._latency_ms}мс`);
    el('llmMeta').textContent = metaParts.join(' · ');

    el('btnApplySuggested').disabled = false;
    el('btnKeepMine').disabled = false;
    el('btnCheck').disabled = false;
    setMsg('Проверка выполнена. Выберите, что принять.', 'ok');
  } catch (e) {
    resetLlmUI();
    setMsg(`Ошибка проверки: ${e.message}`, 'bad');
  } finally {
    state.llmChecking = false;
    if (state.autosavePending) scheduleAutosave();
  }
}

async function applySuggested(keepMine) {
  if (state.llmChecking || state.applyingSuggested || state.submitting) return;

  cancelAutosave();
  const editableIds = ['title', 'desc', 'lat', 'lng', 'btnClearCoords', 'category', 'pileCount', 'images'];
  const saveWasDisabled = el('btnSaveDraft').disabled;
  const submitWasDisabled = el('btnSubmit').disabled;
  let applied = false;
  state.applyingSuggested = true;
  editableIds.forEach((id) => { el(id).disabled = true; });
  el('btnSaveDraft').disabled = true;
  el('btnCheck').disabled = true;
  el('btnApplySuggested').disabled = true;
  el('btnKeepMine').disabled = true;
  el('btnSubmit').disabled = true;

  return applySuggestedLocked(keepMine)
    .then(() => { applied = true; })
    .finally(() => {
      state.applyingSuggested = false;
      editableIds.forEach((id) => { el(id).disabled = false; });
      el('btnSaveDraft').disabled = saveWasDisabled;
      el('btnCheck').disabled = false;
      el('btnApplySuggested').disabled = false;
      el('btnKeepMine').disabled = false;
      if (!applied) el('btnSubmit').disabled = submitWasDisabled;
      if (state.autosavePending) scheduleAutosave();
    });
}

async function applySuggestedLocked(keepMine) {
  await saveDraft();
  const id = await ensureDraft();
  const { title, techDescription, category, pileCount } = getForm();

  const titleFinal = keepMine ? title : state.llmLast?.title_suggested || title;
  const descFinal = keepMine ? techDescription : state.llmLast?.techDescription_suggested || techDescription;

  await queueDraftWrite(() => api(`/api/submissions/draft/${id}/apply-llm`, {
    method: 'POST',
    body: JSON.stringify({
      title_operator_final: titleFinal,
      techDescription_operator_final: descFinal,
      category,
      pileCount,
      llm: {
        provider: state.llmLast?._provider || 'openai-compatible',
        model: state.llmLast?._model || 'unknown',
        base_url: state.llmLast?._base_url || null,
        prompt_version: state.llmLast?._prompt_version || 'v1',
        checked_at: new Date().toISOString(),
        latency_ms: state.llmLast?._latency_ms || null,
        usage: state.llmLast?._usage || null,
        warnings: state.llmLast?.warnings || [],
        confidence: state.llmLast?.confidence || 'medium',
        category_suggested: state.llmLast?.category_suggested || null,
        pileCount_suggested: state.llmLast?.pileCount_suggested,
      },
    }),
  }));

  el('title').value = titleFinal;
  el('desc').value = descFinal;

  el('btnSubmit').disabled = false;
  setMsg(keepMine ? 'Оставили ваш текст. Можно отправлять.' : 'Приняли правки AI. Можно отправлять.', 'ok');
}

async function submitToAdmin() {
  if (state.llmChecking || state.applyingSuggested || state.submitting) return;

  const editableIds = ['title', 'desc', 'lat', 'lng', 'btnClearCoords', 'category', 'pileCount', 'images'];
  const saveWasDisabled = el('btnSaveDraft').disabled;
  const submitWasDisabled = el('btnSubmit').disabled;
  let submitted = false;
  state.submitting = true;
  cancelAutosave();
  editableIds.forEach((id) => { el(id).disabled = true; });
  el('btnSaveDraft').disabled = true;
  el('btnCheck').disabled = true;
  el('btnApplySuggested').disabled = true;
  el('btnKeepMine').disabled = true;
  el('btnSubmit').disabled = true;

  return submitToAdminLocked()
    .then(() => { submitted = true; })
    .finally(() => {
      state.submitting = false;
      editableIds.forEach((id) => { el(id).disabled = false; });
      el('btnSaveDraft').disabled = saveWasDisabled;
      el('btnCheck').disabled = false;
      el('btnApplySuggested').disabled = false;
      el('btnKeepMine').disabled = false;
      el('btnSubmit').disabled = submitted || submitWasDisabled;
      if (state.autosavePending) scheduleAutosave();
    });
}

async function submitToAdminLocked() {
  await saveDraft();
  const id = await ensureDraft();
  const out = await queueDraftWrite(() => api(`/api/submissions/draft/${id}/submit`, { method: 'POST', body: JSON.stringify({}) }));
  const via = out?.via;
  if (via === 'inbox') setMsg('Заявка ушла в приёмник', 'ok');
  else if (via === 'email_fallback') setMsg('Приёмник недоступен, ушло письмом', 'ok');
  else setMsg('Заявка отправлена администратору', 'ok');
  state.llmLast = null;
  state.photosUploaded = 0;
  state.photoImages = [];
  state.autosavePending = false;
  el('btnSubmit').disabled = true;
  renderPhotoList();
  updateImagesInfo();
  setAutosaveStatus('');
}

async function initSiteConfig() {
  const fallback = { center: [56.2285, 58.014746], zoom: 9 };
  const sel = el('category');
  try {
    const cfg = await api('/api/config', { method: 'GET' });
    state.siteConfig = cfg;

    if (cfg.siteName) {
      document.title = cfg.siteName;
      const brandTitle = document.querySelector('.brand__title');
      if (brandTitle) brandTitle.textContent = cfg.siteName;
    }

    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— выберет AI после проверки —';
    sel.appendChild(ph);
    (cfg.categories || []).forEach((c) => {
      const o = document.createElement('option');
      o.value = c.value;
      o.textContent = c.label;
      sel.appendChild(o);
    });

    const required = cfg.pileCount?.required === true;
    const badge = document.querySelector('#pileCount')?.closest('.field-block')?.querySelector('.field-badge');
    if (badge) {
      const label = required ? 'Количество свай *' : 'Количество свай';
      const chip = badge.querySelector('.ai-chip');
      badge.textContent = label + ' ';
      if (chip) badge.appendChild(chip);
    }
    el('pileCount').required = required;
    el('pileCount').placeholder = required ? 'обязательно — заполняет AI из описания' : 'заполняет AI из описания';

    return {
      center: Array.isArray(cfg.mapCenter) ? cfg.mapCenter : fallback.center,
      zoom: Number.isInteger(cfg.mapZoom) ? cfg.mapZoom : fallback.zoom,
    };
  } catch (e) {
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— настройки не загрузились —';
    sel.appendChild(ph);
    setMsg('Не удалось загрузить настройки сайта (GET /api/config). Проверьте сервер и config/site.json.', 'bad');
    return fallback;
  }
}

async function initYandexMap(initialCenter, initialZoom) {
  const status = el('envStatus');
  try {
    const cfg = await api('/api/yandex-maps-script', { method: 'GET' });
    status.textContent = 'YMaps: ok';
    // стиль управляется через .pill в styles.css

    const s = document.createElement('script');
    s.id = 'ymaps3-script';
    s.src = cfg.url;
    s.async = true;
    document.head.appendChild(s);

    await new Promise((resolve, reject) => {
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Yandex Maps script'));
    });

    const waitForYMaps = async (timeoutMs = 10000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (window.ymaps3 && window.ymaps3.ready) return window.ymaps3;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('ymaps3 not available');
    };

    const ymaps3 = await waitForYMaps();
    await ymaps3.ready;

    const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapMarker } = ymaps3;
    const YMapListener = ymaps3.YMapListener;

    const mapEl = el('map');
    const map = new YMap(mapEl, {
      location: { center: initialCenter, zoom: initialZoom },
      behaviors: ['drag', 'pinchZoom', 'scrollZoom', 'dblClick'],
    });
    map.addChild(new YMapDefaultSchemeLayer({}));
    map.addChild(new YMapDefaultFeaturesLayer({}));

    let marker = null;
    let currentZoom = initialZoom;

    function setCoords(lat, lng) {
      if (state.applyingSuggested || state.submitting) return;
      el('lat').value = String(lat);
      el('lng').value = String(lng);
      const center = [lng, lat];
      const zoomToUse = currentZoom <= 9 ? 13 : currentZoom;
      map.setLocation({ center, zoom: zoomToUse });
      currentZoom = zoomToUse;
      if (marker) map.removeChild(marker);
      const mEl = document.createElement('div');
      mEl.style.width = '14px';
      mEl.style.height = '14px';
      mEl.style.borderRadius = '50%';
      mEl.style.border = '2px solid #fff';
      mEl.style.background = '#f97316';
      marker = new YMapMarker({ coordinates: center }, mEl);
      map.addChild(marker);
      scheduleAutosave();
    }

    if (typeof YMapListener === 'function') {
      map.addChild(
        new YMapListener({
          layer: 'any',
          onClick: (_layer, event) => {
            const coords = event?.coordinates;
            if (Array.isArray(coords) && coords.length === 2) {
              setCoords(coords[1], coords[0]);
            }
          },
        }),
      );
    }

    map.addChild(
      new YMapListener({
        layer: 'any',
        onUpdate: (update) => {
          if (update?.location?.zoom != null) {
            currentZoom = update.location.zoom;
          }
        },
      }),
    );

    function clearCoords() {
      if (!marker) return;
      map.removeChild(marker);
      marker = null;
    }

    ['lat', 'lng'].forEach((id) => {
      el(id).addEventListener('blur', () => {
        const lat = parseNum(el('lat').value);
        const lng = parseNum(el('lng').value);
        if (lat != null && lng != null) setCoords(lat, lng);
      });
    });

    state.ymap.ready = true;
    state.ymap.setCoords = setCoords;
    state.ymap.clearCoords = clearCoords;
  } catch (e) {
    status.textContent = 'YMaps: missing';
    status.style.borderColor = 'rgba(245,158,11,0.35)';
    status.style.color = '#ffd79a';
    setMsg('Карта не загрузилась. Можно вводить координаты вручную.', 'bad');
  }
}

function wire() {
  el('btnSaveDraft').addEventListener('click', () => saveDraft().catch((e) => setMsg(e.message, 'bad')));
  el('btnNewApplication').addEventListener('click', startNewApplication);
  el('btnClearCoords').addEventListener('click', clearCoordinateFields);
  el('btnCheck').addEventListener('click', () => checkLLM());
  el('btnApplySuggested').addEventListener('click', () => applySuggested(false).catch((e) => setMsg(e.message, 'bad')));
  el('btnKeepMine').addEventListener('click', () => applySuggested(true).catch((e) => setMsg(e.message, 'bad')));
  el('btnSubmit').addEventListener('click', () => submitToAdmin().catch((e) => setMsg(e.message, 'bad')));

  ['title', 'desc', 'lat', 'lng'].forEach((id) => {
    el(id).addEventListener('input', scheduleAutosave);
  });

  el('images').addEventListener('change', () => handleImageSelection());

  const fileRow = el('fileRow');
  fileRow.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.relatedTarget && fileRow.contains(e.relatedTarget)) return;
    fileRow.classList.add('file-row--over');
  });
  fileRow.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    fileRow.classList.add('file-row--over');
  });
  fileRow.addEventListener('dragleave', (e) => {
    if (!fileRow.contains(e.relatedTarget)) fileRow.classList.remove('file-row--over');
  });
  fileRow.addEventListener('drop', (e) => {
    e.preventDefault();
    fileRow.classList.remove('file-row--over');
    const files = e.dataTransfer?.files;
    if (files?.length) handleImageSelection(files);
  });

  // Вставка координат одной строкой (широта + долгота через запятую/пробел/точку с запятой)
  el('lat').addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    const parts = pasted
      .replace(/\s+/g, ' ')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseNum(s))
      .filter((n) => n !== null);

    if (parts.length >= 2 && Math.abs(parts[0]) <= 90 && Math.abs(parts[1]) <= 180) {
      e.preventDefault();
      // Авто-определение порядка: если первое > 90 — это долгота
      let [a, b] = parts;
      if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
      el('lat').value = String(a);
      el('lng').value = String(b);
      if (state.ymap.ready && state.ymap.setCoords) {
        state.ymap.setCoords(a, b);
      } else {
        scheduleAutosave();
      }
    }
  });
}

wire();
(async () => {
  const { center, zoom } = await initSiteConfig();
  await initYandexMap(center, zoom);
})();
