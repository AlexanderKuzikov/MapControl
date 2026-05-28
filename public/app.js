let state = {
  submissionId: null,
  llmLast: null,
  ymap: { ready: false },
};

const el = (id) => document.getElementById(id);

function setMsg(text, kind = 'ok') {
  const box = el('msg');
  box.className = 'msg ' + (kind === 'ok' ? 'msg__ok' : 'msg__bad');
  box.textContent = text;
}

function parseNum(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function getForm() {
  const title = el('title').value.trim();
  const techDescription = el('desc').value.trim();
  const lat = parseNum(el('lat').value);
  const lng = parseNum(el('lng').value);
  const coords = lat != null && lng != null ? [lat, lng] : null;
  const images = el('images').files ? Array.from(el('images').files) : [];
  return { title, techDescription, coords, images };
}

function validateBeforeCheck() {
  const { title, techDescription, coords, images } = getForm();
  const missing = [];
  if (!title) missing.push('Заголовок');
  if (!techDescription) missing.push('Описание');
  if (!coords) missing.push('Координаты');
  if (!images.length) missing.push('Фото (минимум 1)');
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

async function ensureDraft() {
  if (state.submissionId) return state.submissionId;
  const { submissionId } = await api('/api/submissions/draft', { method: 'POST', body: JSON.stringify({}) });
  state.submissionId = submissionId;
  setMsg(`Черновик создан: ${submissionId}`, 'ok');
  return submissionId;
}

async function saveDraft() {
  const { title, techDescription, coords } = getForm();
  if (!title || !techDescription || !coords) {
    setMsg('Чтобы сохранить черновик, заполните заголовок, описание и координаты.', 'bad');
    return;
  }
  const id = await ensureDraft();
  await api(`/api/submissions/draft/${id}/update`, {
    method: 'POST',
    body: JSON.stringify({ title, techDescription, coords }),
  });
  setMsg('Черновик сохранён.', 'ok');
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
  const res = await fetch(`/api/submissions/draft/${id}/images`, { method: 'POST', body: fd });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error || `Upload failed (HTTP ${res.status})`);
  }
  el('imagesInfo').textContent = `Загружено: ${json.images.length} (обработано в WebP)`;
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

async function checkLLM() {
  const missing = validateBeforeCheck();
  if (missing.length) {
    setMsg(`Заполните обязательные поля: ${missing.join(', ')}.`, 'bad');
    return;
  }

  await saveDraft();
  await uploadImages();

  const { title, techDescription } = getForm();
  renderDiff(`${title}\n\n${techDescription}`, '…');
  renderWarnings([]);
  el('llmMeta').textContent = 'Проверяем…';
  el('btnApplySuggested').disabled = true;
  el('btnKeepMine').disabled = true;
  el('btnSubmit').disabled = true;

  const out = await api('/api/llm/check-text', {
    method: 'POST',
    body: JSON.stringify({ title, techDescription }),
  });
  state.llmLast = out;

  const suggested = `${out.title_suggested}\n\n${out.techDescription_suggested}`;
  renderDiff(`${title}\n\n${techDescription}`, suggested);
  renderWarnings(out.warnings || []);
  el('llmMeta').textContent = `confidence: ${out.confidence}` + (out.pileCount_suggested != null ? ` · pileCount_suggested: ${out.pileCount_suggested}` : '');

  el('btnApplySuggested').disabled = false;
  el('btnKeepMine').disabled = false;
  setMsg('Проверка выполнена. Выберите, что принять.', 'ok');
}

async function applySuggested(keepMine) {
  const id = await ensureDraft();
  const { title, techDescription } = getForm();

  const titleFinal = keepMine ? title : state.llmLast?.title_suggested || title;
  const descFinal = keepMine ? techDescription : state.llmLast?.techDescription_suggested || techDescription;

  await api(`/api/submissions/draft/${id}/apply-llm`, {
    method: 'POST',
    body: JSON.stringify({
      title_operator_final: titleFinal,
      techDescription_operator_final: descFinal,
      llm: {
        provider: 'openai-compatible',
        model: 'qwen/qwen3.5-flash',
        prompt_version: 'v1',
        checked_at: new Date().toISOString(),
        warnings: state.llmLast?.warnings || [],
        confidence: state.llmLast?.confidence || 'medium',
        pileCount_suggested: state.llmLast?.pileCount_suggested,
      },
    }),
  });

  // Update inputs to reflect accepted version (UX clarity)
  el('title').value = titleFinal;
  el('desc').value = descFinal;

  el('btnSubmit').disabled = false;
  setMsg(keepMine ? 'Оставили ваш текст. Можно отправлять.' : 'Приняли правки ИИ. Можно отправлять.', 'ok');
}

async function submitToAdmin() {
  const id = await ensureDraft();
  const res = await api(`/api/submissions/draft/${id}/submit`, { method: 'POST', body: JSON.stringify({}) });
  setMsg(`Заявка отправлена администратору: ${res.submissionId}`, 'ok');
  el('btnSubmit').disabled = true;
}

async function initYandexMap() {
  const status = el('envStatus');
  try {
    const cfg = await api('/api/yandex-maps-script', { method: 'GET' });
    status.textContent = 'YMaps: ok';
    status.style.borderColor = 'rgba(34,197,94,0.35)';
    status.style.color = '#b7ffd1';

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
    // YMaps v3 uses [lng, lat] order (GeoJSON convention)
    // Perm office: lat=58.014746, lng=56.2285
    const initialCenter = [56.2285, 58.014746];
    const map = new YMap(mapEl, {
      location: { center: initialCenter, zoom: 9 },
      behaviors: ['drag', 'pinchZoom', 'scrollZoom', 'dblClick'],
    });
    map.addChild(new YMapDefaultSchemeLayer({}));
    map.addChild(new YMapDefaultFeaturesLayer({}));

    let marker = null;
    // Track current zoom to avoid resetting it on marker placement
    let currentZoom = 9;

    function setCoords(lat, lng) {
      el('lat').value = String(lat);
      el('lng').value = String(lng);
      // YMaps v3: coordinates are [lng, lat]
      const center = [lng, lat];
      // Zoom in only if still at initial overview zoom, otherwise preserve user's zoom
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
    }

    // Click on map → set coordinates
    // YMaps v3 onClick event.coordinates is [lng, lat]
    if (typeof YMapListener === 'function') {
      map.addChild(
        new YMapListener({
          layer: 'any',
          onClick: (_layer, event) => {
            const coords = event?.coordinates;
            if (Array.isArray(coords) && coords.length === 2) {
              // coords = [lng, lat] — swap for setCoords(lat, lng)
              setCoords(coords[1], coords[0]);
            }
          },
        }),
      );
    }

    // Track zoom changes so we can preserve it in setCoords
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

    // Manual coords edit moves marker on blur
    ['lat', 'lng'].forEach((id) => {
      el(id).addEventListener('blur', () => {
        const lat = parseNum(el('lat').value);
        const lng = parseNum(el('lng').value);
        if (lat != null && lng != null) setCoords(lat, lng);
      });
    });

    state.ymap.ready = true;
  } catch (e) {
    status.textContent = 'YMaps: missing';
    status.style.borderColor = 'rgba(245,158,11,0.35)';
    status.style.color = '#ffd79a';
    setMsg('Карта не загрузилась. Можно вводить координаты вручную.', 'bad');
  }
}

function wire() {
  el('btnSaveDraft').addEventListener('click', () => saveDraft().catch((e) => setMsg(e.message, 'bad')));
  el('btnCheck').addEventListener('click', () => checkLLM().catch((e) => setMsg(e.message, 'bad')));
  el('btnApplySuggested').addEventListener('click', () => applySuggested(false).catch((e) => setMsg(e.message, 'bad')));
  el('btnKeepMine').addEventListener('click', () => applySuggested(true).catch((e) => setMsg(e.message, 'bad')));
  el('btnSubmit').addEventListener('click', () => submitToAdmin().catch((e) => setMsg(e.message, 'bad')));

  el('images').addEventListener('change', () => {
    const { images } = getForm();
    el('imagesInfo').textContent = images.length ? `Выбрано файлов: ${images.length}` : '';
  });
}

wire();
initYandexMap();
