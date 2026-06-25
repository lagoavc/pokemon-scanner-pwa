const POKEMON_TCG_API = 'https://api.pokemontcg.io/v2';
const OCR_SPACE_API = 'https://api.ocr.space/parse/image';
const TCGDEX_API = 'https://api.tcgdex.net/v2/en';
const STORAGE_KEY = 'pokescanner_cards';
const API_KEY_STORAGE = 'ocr_api_key';
const PRIVACY_KEY = 'privacy_accepted';
const PRICE_REFRESH_HOURS = 1;

let cards = [];
let pendingCard = null;
let lastPricing = null;
let editingIndex = -1;
let cameraStream = null;
let cameraStoppedForBattery = false;

const $ = id => document.getElementById(id);
const $$ = (sel, ctx = document) => ctx.querySelector(sel);
const $$$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function toast(msg, dur = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), dur);
}

function openPanel(id) {
  $$$('.slide-panel.open').forEach(p => p.classList.remove('open'));
  const panel = $(id);
  panel.classList.remove('hidden');
  panel.classList.add('open');
  $('modal-overlay').classList.remove('hidden');
}

function closeAllPanels() {
  $$$('.slide-panel.open').forEach(p => p.classList.remove('open'));
  $('modal-overlay').classList.add('hidden');
  editingIndex = -1;
  if (cameraStoppedForBattery) startCamera();
}

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}

// ─── API Key Management ─────────────────────────────────
function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}
function setApiKey(key) {
  localStorage.setItem(API_KEY_STORAGE, key);
}

// ─── Camera ──────────────────────────────────────────────
let cameraStream = null;

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
    cameraStoppedForBattery = true;
  }
  $('video-camera').srcObject = null;
}

async function startCamera() {
  const video = $('video-camera');
  const errEl = $('camera-error');
  cameraStoppedForBattery = false;
  stopCamera();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    cameraStream = stream;
    video.srcObject = stream;
    await video.play();
    errEl.classList.add('hidden');
  } catch (e) {
    console.error('Camera error:', e);
    errEl.classList.remove('hidden');
  }
}

// Alias for backward compat
const initCamera = startCamera;

function capturePhoto() {
  const video = $('video-camera');
  if (!video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  const maxDim = 2000;
  let w = video.videoWidth, h = video.videoHeight;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function cropRegion(imgData, topPct, heightPct) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const sy = Math.round(img.height * topPct);
      const sh = Math.round(img.height * heightPct);
      c.width = img.width;
      c.height = sh;
      c.getContext('2d').drawImage(img, 0, sy, img.width, sh, 0, 0, img.width, sh);
      resolve(c.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = () => reject(new Error('Falha ao carregar imagem'));
    img.src = imgData;
  });
}
function cropTop(imgData) { return cropRegion(imgData, 0, 0.25); }
function cropBottom(imgData) { return cropRegion(imgData, 0.35, 0.65); }

// ─── OCR (direct from browser) ────────────────────────────
async function ocrSpace(imageData, label) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('API key do OCR.space não configurada. Abra Ajuda > Definições.');
  }
  const body = new URLSearchParams();
  body.append('apikey', apiKey);
  body.append('base64Image', imageData);
  body.append('language', 'eng');
  body.append('isOverlayRequired', 'false');
  body.append('OCREngine', '2');
  body.append('filetype', 'jpg');

  const r = await fetch(OCR_SPACE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  });
  if (r.status === 403 || r.status === 429) {
    throw new Error('Limite do OCR.space atingido (10 requests/dia no free). Usa outra chave ou aguarda.');
  }
  if (!r.ok) throw new Error(`OCR.space HTTP ${r.status}`);

  const data = await r.json();
  if (data.IsErroredOnProcessing || data.ErrorMessage) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage[0] : data.ErrorMessage || 'Erro no OCR.space';
    const msgLower = msg.toLowerCase();
    if (msgLower.includes('limit') || msgLower.includes('daily') || msgLower.includes('exceed')) {
      throw new Error('Limite diário do OCR.space atingido (10 requests/dia no plano free).');
    }
    throw new Error(msg);
  }
  let text = data.ParsedResults?.[0]?.ParsedText || '';
  text = text.replace(/\r/g, '');
  console.log(`[OCR ${label}]`, text.slice(0, 300));
  return parseOCROutput(text);
}

function normalizeNumber(n) {
  return n.replace(/[Oo]/g, '0').replace(/[Ll]/g, '1').replace(/[Ss]/g, '5');
}
function parseCollectorNumber(raw) {
  const m = raw.match(/^0*(\d+)\/\d+$/);
  return m ? m[1] : raw;
}

function parseOCROutput(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = { name: text, number: '', set: '' };
  const langCodes = new Set(['ENG','JPN','FRA','GER','ITA','SPA','CHS','CHT','KOR','POR']);
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(/(\d{2,3}\/\d{2,4})/);
    if (!m) {
      const normalized = normalizeNumber(lines[i]);
      m = normalized.match(/(\d{2,3}\/\d{2,4})/);
    }
    if (!m) continue;
    result.number = m[1];
    const beforeNum = lines[i].slice(0, m.index).toUpperCase();
    const codes = beforeNum.match(/([A-Z]{2,4})/g);
    if (codes) {
      for (const c of codes) {
        const s = c.slice(0, 3);
        if (!langCodes.has(s) && s !== result.number.split('/')[0]) { result.set = s; break; }
      }
    }
    if (!result.set) {
      const ignoreWords = new Set(['WEA','RES','RET','BAS','STA','POK','TRA','ATT','ABI','DAR','FIG','WAT','GRA','LIG','PSY','MET','FGT','COL','FRE','DRA','FAI']);
      for (let offset = 1; offset <= 5; offset++) {
        for (const j of [i - offset, i + offset]) {
          if (j < 0 || j >= lines.length || j === i) continue;
          const codes = lines[j].toUpperCase().match(/([A-Z]{2,4})/g);
          if (!codes) continue;
          for (const c of codes) {
            const s = c.slice(0, 3);
            if (!langCodes.has(s) && !ignoreWords.has(s)) { result.set = s; break; }
          }
          if (result.set) break;
        }
        if (result.set) break;
      }
    }
    break;
  }
  return result;
}

// ─── Pokemon TCG API ─────────────────────────────────────
async function searchPokemonCard(name, set, number) {
  const parts = [];
  if (name) parts.push(`name:"${name}"`);
  if (set && set.length > 2) parts.push(`set.name:"${set}"`);
  if (number) parts.push(`number:"${number}"`);
  if (parts.length === 0) return [];
  const q = parts.join(' ');
  try {
    const r = await fetch(`${POKEMON_TCG_API}/cards?q=${encodeURIComponent(q)}&pageSize=10`);
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    const data = await r.json();
    return data.data || [];
  } catch (e) {
    console.error('API search error:', e);
    toast('Erro ao pesquisar carta');
    return [];
  }
}

async function searchCardByNumber(number) {
  const num = parseCollectorNumber(number);
  try {
    const r = await fetch(`${POKEMON_TCG_API}/cards?q=number:"${num}"&pageSize=10`);
    if (!r.ok) return [];
    const data = await r.json();
    return data.data || [];
  } catch { return []; }
}

// ─── TCGdex Prices ────────────────────────────────────────
async function fetchTCGdexPrice(cardId, cardName, cardNumber) {
  if (!cardId) return null;

  const tryFetch = async (id) => {
    try {
      const r = await fetch(`${TCGDEX_API}/cards/${id}`);
      if (!r.ok) return null;
      const data = await r.json();
      return data.pricing?.cardmarket || null;
    } catch {
      return null;
    }
  };

  let pricing = await tryFetch(cardId);
  if (pricing) return pricing;

  // Try alternative ID formats (zero-padded set, 3-digit number)
  const parts = cardId.split('-');
  if (parts.length === 2) {
    const altIds = [];
    const paddedSet = parts[0].replace(/^(sv)(\d)$/i, '$10$2');
    if (paddedSet !== parts[0]) {
      altIds.push(`${paddedSet}-${parts[1]}`);
      altIds.push(`${paddedSet}-${parts[1].padStart(3, '0')}`);
    }
    const paddedNum = parts[1].padStart(3, '0');
    if (paddedNum !== parts[1]) {
      altIds.push(`${parts[0]}-${paddedNum}`);
    }
    for (const id of altIds) {
      pricing = await tryFetch(id);
      if (pricing) return pricing;
    }
  }

  // Fallback: search by name + number
  if (cardName && cardNumber) {
    try {
      const r = await fetch(`${TCGDEX_API}/cards?name=${encodeURIComponent(cardName)}`);
      if (r.ok) {
        const results = await r.json();
        const num = String(cardNumber).replace(/^0+/, '');
        const match = results.find(c => String(c.localId).replace(/^0+/, '') === num);
        if (match) {
          pricing = await tryFetch(match.id);
          if (pricing) return pricing;
        }
      }
    } catch {}
  }

  return null;
}

function updatePriceFromPricing(holo) {
  if (!lastPricing) return;
  const key = holo ? 'avg-holo' : 'avg';
  const val = lastPricing[key] ?? lastPricing.avg;
  if (val != null) {
    $('field-price').value = val.toFixed(2);
  }
}

// ─── CSV Export ───────────────────────────────────────────
function escapeCSV(val) {
  const s = String(val ?? '');
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function generateCSVSimple() {
  const header = 'Name;Expansion;CollectorNumber;Language;Condition;Price;Quantity;ReverseHolo';
  const rows = cards.map(c => [
    c.name, c.set, c.number, c.language, c.condition,
    c.price.toFixed(2), c.quantity, c.holo ? 'Yes' : 'No'
  ].map(escapeCSV).join(';'));
  return '# PokéScanner Export - ' + formatDate() + '\n' + header + '\n' + rows.join('\n');
}

function generateCSVCardmarket() {
  const header = 'idProduct;groupCount;price;idLanguage;condition;isFoil;isSigned;isAltered;isPlayset;isReverseHolo;isFirstEd;isFullArt;isUberRare;isWithDie';
  const langMap = { 'English':1,'French':2,'German':3,'Spanish':4,'Italian':5,'Portuguese':6,'Japanese':7,'Korean':10,'Chinese Simplified':8,'Chinese Traditional':9,'Russian':11 };
  const condMap = { 'MT':1,'NM':1,'EX':2,'GD':3,'LP':4,'PL':5,'PO':6 };
  const rows = cards.map(c => [
    '', c.quantity, c.price.toFixed(2), langMap[c.language] || 1,
    condMap[c.condition] || 1, '', '', '', '', c.holo ? '1' : '', '', '', '', ''
  ].join(';'));
  return header + '\n' + rows.join('\n');
}

function generateCSVTCGPowerTools() {
  const header = 'Quantity;Name;Expansion;Collector Number;Language;Condition;Price;Reverse Holo';
  const rows = cards.map(c => [
    c.quantity, c.name, c.set, c.number, c.language, c.condition,
    c.price.toFixed(2), c.holo ? 'Yes' : 'No'
  ].map(escapeCSV).join(';'));
  return '# PokéScanner - TCGPowerTools Import\n' + header + '\n' + rows.join('\n');
}

function downloadCSV(content, filename) {
  const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── JSON Backup / Restore ────────────────────────────────
function exportJSON() {
  if (cards.length === 0) { toast('Lista vazia'); return; }
  const data = { version: '1.0.0', exportedAt: new Date().toISOString(), cards: cards };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pokescanner_${formatDate()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('📥 Backup JSON exportado');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const imported = data.cards || (Array.isArray(data) ? data : []);
      if (!imported.length) { toast('Nenhuma carta encontrada no ficheiro'); return; }
      if (cards.length > 0) {
        if (confirm(`Já tens ${cards.length} cartas. OK = Substituir | Cancelar = Adicionar`)) {
          cards = imported;
        } else {
          cards = cards.concat(imported);
        }
      } else {
        cards = imported;
      }
      migrateCards();
      saveCards();
      renderCollection();
      toast(`✅ ${imported.length} carta(s) importada(s)`);
    } catch {
      toast('❌ Ficheiro JSON inválido');
    }
  };
  reader.readAsText(file);
}

// ─── Persistence & Migration ──────────────────────────────
function saveCards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
}

function migrateCard(c) {
  if (c.image === undefined) c.image = '';
  if (c.setId === undefined) c.setId = '';
  if (c.cardmarketPrice === undefined) c.cardmarketPrice = null;
  if (c.cardmarketPriceHolo === undefined) c.cardmarketPriceHolo = null;
  if (c.lastPriceUpdate === undefined) c.lastPriceUpdate = null;
  return c;
}

function migrateCards() {
  cards = cards.map(migrateCard);
}

function loadCards() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    cards = stored ? JSON.parse(stored) : [];
    migrateCards();
  } catch {
    cards = [];
  }
}

// ─── Price Refresh ────────────────────────────────────────
function needsPriceRefresh(lastUpdate) {
  if (!lastUpdate) return true;
  const diff = Date.now() - new Date(lastUpdate).getTime();
  return diff > PRICE_REFRESH_HOURS * 60 * 60 * 1000;
}

async function refreshPrices() {
  const toRefresh = cards.filter(c => needsPriceRefresh(c.lastPriceUpdate) && c.setId && c.number);
  if (toRefresh.length === 0) return;

  console.log(`Refreshing prices for ${toRefresh.length} cards...`);
  const batchSize = 5;
  for (let i = 0; i < toRefresh.length; i += batchSize) {
    const batch = toRefresh.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(c => fetchTCGdexPrice(`${c.setId}-${parseCollectorNumber(c.number)}`, c.name, c.number))
    );
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) {
        const pricing = result.value;
        const cardIdx = cards.indexOf(batch[idx]);
        if (cardIdx >= 0) {
          cards[cardIdx].cardmarketPrice = pricing.avg ?? null;
          cards[cardIdx].cardmarketPriceHolo = pricing['avg-holo'] ?? null;
          cards[cardIdx].lastPriceUpdate = new Date().toISOString();
        }
      }
    });
    if (i + batchSize < toRefresh.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  saveCards();
  console.log('Price refresh complete');
}

// ─── Privacy ──────────────────────────────────────────────
function checkPrivacy() {
  if (!localStorage.getItem(PRIVACY_KEY)) {
    $('privacy-overlay').classList.remove('hidden');
  }
}

// ─── Sort ─────────────────────────────────────────────────
let sortKey = 'name-asc';

function sortCards() {
  const [field, dir] = sortKey.split('-');
  cards.sort((a, b) => {
    let cmp;
    if (field === 'name') {
      cmp = (a.name || '').localeCompare(b.name || '');
    } else if (field === 'price') {
      const pa = a.holo ? (a.cardmarketPriceHolo ?? a.cardmarketPrice ?? 0) : (a.cardmarketPrice ?? 0);
      const pb = b.holo ? (b.cardmarketPriceHolo ?? b.cardmarketPrice ?? 0) : (b.cardmarketPrice ?? 0);
      cmp = pa - pb;
    }
    return dir === 'desc' ? -cmp : cmp;
  });
}

$$('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.sort === sortKey) return;
    sortKey = btn.dataset.sort;
    $$('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === sortKey));
    sortCards();
    renderCollection();
  });
});

// ─── Collection UI ────────────────────────────────────────
function renderCollection() {
  sortCards();
  const grid = $('collection-grid');
  const empty = $('empty-msg');
  const header = $('list-content');

  grid.innerHTML = '';
  if (cards.length === 0) {
    empty.classList.remove('hidden');
    header.classList.add('hidden');
    $('count-badge').textContent = '0';
    return;
  }
  empty.classList.add('hidden');
  header.classList.remove('hidden');
  $('count-badge').textContent = cards.length;

  cards.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'card-tile';
    div.setAttribute('data-index', i);

    const imgSrc = c.image || '';
    const price = c.holo ? (c.cardmarketPriceHolo ?? c.cardmarketPrice) : c.cardmarketPrice;
    const priceStr = price != null ? `€${price.toFixed(2)}` : '';

    div.innerHTML = `
      <div class="ct-img">${imgSrc ? `<img src="${imgSrc}" alt="${escapeCSV(c.name)}" loading="lazy">` : '<div class="ct-placeholder">?</div>'}</div>
      <div class="ct-info">
        <div class="ct-name">${escapeCSV(c.name)}</div>
        <div class="ct-meta">${escapeCSV(c.set)} ${escapeCSV(c.number)}</div>
        <div class="ct-price">${priceStr}</div>
      </div>
    `;
    div.addEventListener('click', () => showCardDetail(i));
    grid.appendChild(div);
  });
}

function showCardDetail(index) {
  const c = cards[index];
  if (!c) return;

  $('dt-image').src = c.image || '';
  $('dt-name').textContent = c.name;
  $('dt-set').textContent = c.set;
  $('dt-number').textContent = c.number;
  $('dt-condition').textContent = c.condition;
  $('dt-language').textContent = c.language;
  $('dt-quantity').textContent = c.quantity;

  const holoLabel = c.holo ? 'Yes' : 'No';
  const holoDisplay = document.querySelector('#dt-holo-row');
  if (holoDisplay) holoDisplay.textContent = holoLabel;

  const userPrice = c.price ?? 0;
  const cmPrice = c.holo ? (c.cardmarketPriceHolo ?? c.cardmarketPrice) : c.cardmarketPrice;
  const cmPriceStr = cmPrice != null ? `€${cmPrice.toFixed(2)}` : '—';

  $('dt-user-price').innerHTML = `€${userPrice.toFixed(2)}`;
  $('dt-cm-price').innerHTML = `${cmPriceStr}`;

  const lastUpd = c.lastPriceUpdate ? new Date(c.lastPriceUpdate).toLocaleString() : 'Nunca';
  $('dt-price-updated').textContent = lastUpd;

  $('detail-delete').dataset.index = index;
  $('detail-edit').dataset.index = index;

  openPanel('panel-detail');

  // Refresh price if > 1h since last update
  if (needsPriceRefresh(c.lastPriceUpdate) && c.setId && c.number) {
    fetchTCGdexPrice(`${c.setId}-${parseCollectorNumber(c.number)}`, c.name, c.number).then(pricing => {
      if (pricing) {
        c.cardmarketPrice = pricing.avg ?? null;
        c.cardmarketPriceHolo = pricing['avg-holo'] ?? null;
        c.lastPriceUpdate = new Date().toISOString();
        saveCards();
        // Update detail view inline
        const newCm = c.holo ? (c.cardmarketPriceHolo ?? c.cardmarketPrice) : c.cardmarketPrice;
        $('dt-cm-price').innerHTML = newCm != null ? `€${newCm.toFixed(2)}` : '—';
        $('dt-price-updated').textContent = new Date(c.lastPriceUpdate).toLocaleString();
        renderCollection();
      }
    });
  }
}

// Manual price refresh in detail panel
$('dt-refresh-price').addEventListener('click', async () => {
  const c = cards[+$('detail-delete').dataset.index];
  if (!c || !c.setId || !c.number) { toast('Sem dados para pesquisar preço'); return; }
  toast('📡 A atualizar preço...');
  const pricing = await fetchTCGdexPrice(`${c.setId}-${parseCollectorNumber(c.number)}`, c.name, c.number);
  if (pricing) {
    c.cardmarketPrice = pricing.avg ?? null;
    c.cardmarketPriceHolo = pricing['avg-holo'] ?? null;
    c.lastPriceUpdate = new Date().toISOString();
    saveCards();
    const newCm = c.holo ? (c.cardmarketPriceHolo ?? c.cardmarketPrice) : c.cardmarketPrice;
    $('dt-cm-price').innerHTML = newCm != null ? `€${newCm.toFixed(2)}` : '—';
    $('dt-price-updated').textContent = new Date(c.lastPriceUpdate).toLocaleString();
    renderCollection();
    toast(`💰 Preço Cardmarket: €${(newCm ?? 0).toFixed(2)}`);
  } else {
    toast('❌ Não foi possível obter preço');
  }
});

function editCard(index) {
  const c = cards[index];
  if (!c) return;
  editingIndex = index;
  closeAllPanels();

  $('field-name').value = c.name;
  $('field-set').value = c.set;
  $('field-number').value = c.number;
  $('field-price').value = c.price.toFixed(2);
  $('field-qty').value = c.quantity;
  $('field-condition').value = c.condition;
  $('field-language').value = c.language;
  $('field-holo').checked = c.holo;
  $('search-results').classList.add('hidden');
  $('card-details').classList.remove('hidden');

  pendingCard = {
    name: c.name, set: c.set, number: c.number, image: c.image || ''
  };

  // Pre-fill price from stored Cardmarket data
  lastPricing = null;
  if (c.cardmarketPrice != null || c.cardmarketPriceHolo != null) {
    lastPricing = { avg: c.cardmarketPrice, 'avg-holo': c.cardmarketPriceHolo };
  }

  // Change button text
  $('btn-add').textContent = '💾 Guardar Alterações';

  openPanel('panel-review');
}

// ─── Review Panel UI ───────────────────────────────────────
function clearReviewPanel() {
  $('field-name').value = '';
  $('field-set').value = '';
  $('field-number').value = '';
  $('field-price').value = '0.00';
  $('field-qty').value = '1';
  $('field-condition').value = 'NM';
  $('field-language').value = 'English';
  $('field-holo').checked = false;
  $('search-results').classList.add('hidden');
  $('search-results').innerHTML = '';
  $('card-details').classList.add('hidden');
  $('captured-img').src = '';
  pendingCard = null;
  lastPricing = null;
  editingIndex = -1;
  $('btn-add').textContent = '✅ Adicionar à Coleção';
}

function showReview(imageData) {
  $('captured-img').src = imageData;
  openPanel('panel-review');
}

// ─── Event Handlers ───────────────────────────────────────

// Capture with OCR
$('btn-capture').addEventListener('click', async () => {
  if (!getApiKey()) { toast('🔑 Configura a API key na Ajuda primeiro'); openPanel('panel-help'); return; }
  const imgData = capturePhoto();
  if (!imgData) { toast('Câmara não disponível'); return; }
  stopCamera();
  toast('📡 OCR em curso...');
  try {
    showReview(imgData);
    const ocr = await ocrSpace(imgData, 'FULL');

    if (ocr && ocr.name) {
      const lines = ocr.name.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        const clean = l.replace(/[^A-Za-zÀ-ÿ0-9\s\-'.!]/g, '').trim();
        if (!clean || clean.length < 3 || /^\d+$/.test(clean)) continue;
        if (clean.split(' ').length > 5) continue;
        if (/^(HP|WEAKNESS|RESISTANCE|RETREAT|POKEMON|POKÉMON|BASIC|STAGE|TYPE|ABILITY|ATTACK|DAMAGE|ENERGY|NO\.|ILLUS|STAGE)/i.test(clean)) continue;
        $('field-name').value = clean;
        break;
      }
    }
    if (ocr && ocr.number) {
      $('field-number').value = ocr.number;
      searchByNumber(ocr.number, ocr.set, $('field-name').value);
      toast(`🔍 OCR: ${$('field-name').value || 'nº ' + ocr.number}`);
    } else if (ocr && !ocr.number) {
      toast('📄 OCR não encontrou nº de carta. Escreve o nome.');
    } else {
      toast('❌ OCR não respondeu. Escreve o nome manualmente.');
    }
  } catch (e) {
    toast(`⚠️ ${e.message}`);
  }
  $('field-name').focus();
});

// Fullscreen button (two-click fallback)
let fsFallbackTimer;
$('btn-fullscreen').addEventListener('click', () => {
  if (fsFallbackTimer) {
    clearTimeout(fsFallbackTimer);
    fsFallbackTimer = null;
    return;
  }
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen()
      .then(() => {})
      .catch(() => {
        fsFallbackTimer = setTimeout(() => { fsFallbackTimer = null; }, 3000);
        toast('Prima o botão de ecrã inteiro do seu navegador', 3000);
      });
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = !!document.fullscreenElement;
  const btn = $('btn-fullscreen');
  if (active) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M8 3v3H3v2h5V3h2zm8 0v5h-2V5h-3V3h5zM3 16v-2h5v5H6v-3H3zm16-2h2v5h-5v-2h3v-3z"/></svg>';
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
  }
});

// File input fallback
$('file-input').addEventListener('change', async (e) => {
  if (!getApiKey()) { toast('🔑 Configura a API key na Ajuda primeiro'); openPanel('panel-help'); return; }
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const imgData = ev.target.result;
    toast('📡 OCR em curso...');
    try {
      showReview(imgData);
      const [topOcr, bottomOcr] = await Promise.all([
        ocrSpace(await cropTop(imgData), 'TOP'),
        ocrSpace(await cropBottom(imgData), 'BOT')
      ]);
      const ocr = bottomOcr;
      const nameLines = (topOcr.name || '').split('\n').map(l => l.trim()).filter(Boolean);
      let cardName = '';
      for (const l of nameLines) {
        const clean = l.replace(/[^A-Za-zÀ-ÿ0-9\s\-'.]/g, '').trim();
        if (!clean || clean.length < 3 || /^\d+$/.test(clean)) continue;
        if (clean.split(' ').length > 6) continue;
        if (/^(HP|WEAKNESS|RESISTANCE|RETREAT|POKEMON|BASIC|STAGE|TYPE|ABILITY|ATTACK|DAMAGE|ENERGY)/i.test(clean)) continue;
        cardName = clean;
        break;
      }
      if (cardName) $('field-name').value = cardName;
      if (ocr && ocr.number) {
        $('field-number').value = ocr.number;
        toast(`🔍 OCR: ${cardName || 'nº ' + ocr.number}`);
        searchByNumber(ocr.number, ocr.set, cardName);
      } else if (ocr && !ocr.number) {
        toast('📄 OCR não encontrou nº de carta. Escreve o nome.');
      } else {
        toast('❌ OCR não respondeu. Escreve o nome manualmente.');
      }
    } catch (e) {
      toast(`⚠️ ${e.message}`);
    }
    $('field-name').focus();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// Auto-suggest
let suggestTimeout = null;
$('field-name').addEventListener('input', () => {
  clearTimeout(suggestTimeout);
  const name = $('field-name').value.trim();
  if (name.length < 2) { $('search-results').classList.add('hidden'); return; }
  suggestTimeout = setTimeout(async () => {
    $('search-results').classList.remove('hidden');
    $('search-results').innerHTML = '<p style="color:var(--text2);padding:8px 0">A pesquisar...</p>';
    const results = await searchPokemonCard(name, '', '');
    if (results.length === 0) {
      $('search-results').innerHTML = '<p style="color:var(--text2);padding:8px 0">Nenhum resultado</p>';
      return;
    }
    $('search-results').innerHTML = '';
    results.slice(0, 6).forEach(card => {
      const div = document.createElement('div');
      div.className = 'search-item';
      div.innerHTML = `
        <img src="${card.images?.small || ''}" alt="${card.name}" onerror="this.style.display='none'">
        <div class="si-info">
          <div class="si-name">${card.name} <span style="color:var(--accent2);font-size:11px">${card.number || ''}</span></div>
          <div class="si-meta">${card.set?.name || ''}</div>
        </div>
      `;
      div.addEventListener('click', () => { selectCard(card); });
      $('search-results').appendChild(div);
    });
  }, 350);
});

// Search by number
async function searchByNumber(number, setCode, cardName) {
  const resultsEl = $('search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<p style="color:var(--text2);padding:8px 0">🔍 A pesquisar...</p>';
  const codeToPtcgo = { 'SVI': 'SV1' };
  const apiNum = parseCollectorNumber(number);
  let cardsRes;
  if (cardName) {
    const q = `name:"${cardName}" number:"${apiNum}"`;
    try {
      const r = await fetch(`${POKEMON_TCG_API}/cards?q=${encodeURIComponent(q)}`);
      if (r.ok) cardsRes = (await r.json()).data || [];
    } catch {}
  }
  if (!cardsRes || cardsRes.length === 0) {
    if (setCode) {
      const ptcgo = codeToPtcgo[setCode] || setCode;
      const q = `number:"${apiNum}" set.ptcgoCode:"${ptcgo}"`;
      try {
        const r = await fetch(`${POKEMON_TCG_API}/cards?q=${encodeURIComponent(q)}`);
        if (r.ok) cardsRes = (await r.json()).data || [];
      } catch {}
    }
  }
  if (!cardsRes || cardsRes.length === 0) {
    if (cardName) {
      try {
        const r = await fetch(`${POKEMON_TCG_API}/cards?q=${encodeURIComponent('name:"' + cardName + '"')}`);
        if (r.ok) cardsRes = (await r.json()).data || [];
      } catch {}
    }
  }
  if (!cardsRes || cardsRes.length === 0) {
    cardsRes = await searchCardByNumber(number);
  }
  if (cardsRes.length === 0) {
    resultsEl.innerHTML = '<p style="color:var(--text2);padding:8px 0">Nenhum resultado para este número</p>';
    return;
  }
  resultsEl.innerHTML = '';
  cardsRes.slice(0, 8).forEach(card => {
    const div = document.createElement('div');
    div.className = 'search-item';
    div.innerHTML = `
      <img src="${card.images?.small || ''}" alt="${card.name}" onerror="this.style.display='none'">
      <div class="si-info">
        <div class="si-name">${card.name} <span style="color:var(--accent2)">${card.number || ''}</span></div>
        <div class="si-meta">${card.set?.name || ''} ${card.rarity ? '• ' + card.rarity : ''}</div>
      </div>
    `;
    div.addEventListener('click', () => { selectCard(card); });
    resultsEl.appendChild(div);
  });
}

// Search button
$('btn-search').addEventListener('click', async () => {
  const name = $('field-name').value.trim();
  const set = $('field-set').value.trim();
  const number = $('field-number').value.trim();
  const resultsEl = $('search-results');
  if (!name && !number) { toast('Preencha o nome ou número da carta'); return; }
  resultsEl.innerHTML = '<p style="color:var(--text2)">A pesquisar...</p>';
  resultsEl.classList.remove('hidden');
  let results;
  if (number && !name) {
    results = await searchCardByNumber(number);
  } else {
    results = await searchPokemonCard(name, set, number);
  }
  if (results.length === 0) {
    resultsEl.innerHTML = '<p style="color:var(--text2);padding:12px 0">Nenhum resultado. Tente outro nome.</p>';
    return;
  }
  resultsEl.innerHTML = '';
  results.forEach(card => {
    const div = document.createElement('div');
    div.className = 'search-item';
    div.innerHTML = `
      <img src="${card.images?.small || ''}" alt="${card.name}" onerror="this.style.display='none'">
      <div class="si-info">
        <div class="si-name">${card.name} <span style="color:var(--accent2);font-size:11px">${card.number || ''}</span></div>
        <div class="si-meta">${card.set?.name || ''} ${card.rarity ? '• ' + card.rarity : ''}</div>
      </div>
    `;
    div.addEventListener('click', () => { selectCard(card); });
    resultsEl.appendChild(div);
  });
});

function selectCard(card) {
  $('field-name').value = card.name;
  $('field-set').value = card.set?.name || '';
  $('field-number').value = card.number || '';
  $('search-results').innerHTML = `<p style="color:var(--accent2);padding:8px 0">✅ Carta selecionada: ${card.name}</p>`;

  pendingCard = {
    name: card.name,
    set: card.set?.name || '',
    number: card.number || '',
    image: card.images?.large || card.images?.small || '',
    setId: card.set?.id || (card.id ? card.id.split('-')[0] : ''),
  };

  $('card-details').classList.remove('hidden');

  // Fetch Cardmarket price from TCGdex
  lastPricing = null;
  fetchTCGdexPrice(card.id, card.name, card.number).then(pricing => {
    if (pricing) {
      lastPricing = pricing;
      const holo = $('field-holo').checked;
      const key = holo ? 'avg-holo' : 'avg';
      const val = pricing[key] ?? pricing.avg;
      if (val != null) {
        $('field-price').value = val.toFixed(2);
        toast(`💰 Preço Cardmarket: €${val.toFixed(2)}`);
      }
    }
  });
}

// Holo checkbox updates price suggestion
$('field-holo').addEventListener('change', () => {
  updatePriceFromPricing($('field-holo').checked);
});

// Add / Save card
$('btn-add').addEventListener('click', () => {
  const name = $('field-name').value.trim();
  if (!name) { toast('Nome da carta é obrigatório'); return; }

  const card = {
    name: name,
    set: $('field-set').value.trim(),
    number: $('field-number').value.trim(),
    condition: $('field-condition').value,
    language: $('field-language').value,
    price: parseFloat($('field-price').value) || 0,
    quantity: parseInt($('field-qty').value) || 1,
    holo: $('field-holo').checked,
    comments: '',
    addedAt: new Date().toISOString(),
    image: pendingCard?.image || '',
    setId: pendingCard?.setId || '',
    cardmarketPrice: lastPricing?.avg ?? null,
    cardmarketPriceHolo: lastPricing?.['avg-holo'] ?? null,
    lastPriceUpdate: lastPricing ? new Date().toISOString() : null
  };

  if (editingIndex >= 0 && editingIndex < cards.length) {
    // Preserve fields not in the edit form
    card.addedAt = cards[editingIndex].addedAt;
    card.comments = cards[editingIndex].comments;
    card.image = card.image || cards[editingIndex].image;
    card.setId = card.setId || cards[editingIndex].setId;
    cards[editingIndex] = card;
    toast(`✏️ "${name}" atualizada`);
  } else {
    cards.push(card);
    toast(`✅ "${name}" adicionada à coleção`);
  }

  saveCards();
  renderCollection();
  closeAllPanels();
  clearReviewPanel();
});

// Navigation
$('btn-list').addEventListener('click', () => {
  renderCollection();
  openPanel('panel-list');
});

$('close-review').addEventListener('click', () => {
  closeAllPanels();
  clearReviewPanel();
});
$('close-list').addEventListener('click', closeAllPanels);
$('close-detail').addEventListener('click', closeAllPanels);
$('modal-overlay').addEventListener('click', closeAllPanels);

$('btn-scan-more').addEventListener('click', () => {
  closeAllPanels();
  clearReviewPanel();
});

// Detail panel actions
$('detail-edit').addEventListener('click', () => {
  const idx = parseInt($('detail-edit').dataset.index);
  if (!isNaN(idx)) editCard(idx);
});

$('detail-delete').addEventListener('click', () => {
  const idx = parseInt($('detail-delete').dataset.index);
  if (isNaN(idx)) return;
  if (confirm(`Remover "${cards[idx]?.name}" da coleção?`)) {
    cards.splice(idx, 1);
    saveCards();
    renderCollection();
    closeAllPanels();
    toast('🗑️ Carta removida');
  }
});

// Export CSV
$('btn-export-csv').addEventListener('click', () => {
  if (cards.length === 0) { toast('Coleção vazia'); return; }
  const opts = $('export-options');
  opts.classList.toggle('hidden');
});

document.querySelectorAll('[data-format]').forEach(btn => {
  btn.addEventListener('click', () => {
    const fmt = btn.dataset.format;
    let content, filename;
    const date = formatDate();
    switch (fmt) {
      case 'simple':
        content = generateCSVSimple();
        filename = `pokescanner_${date}.csv`;
        break;
      case 'cardmarket':
        content = generateCSVCardmarket();
        filename = `cardmarket_bulk_${date}.csv`;
        break;
      case 'tcgpt':
        content = generateCSVTCGPowerTools();
        filename = `tcgpowertools_${date}.csv`;
        break;
    }
    downloadCSV(content, filename);
    toast(`📥 Exportado: ${filename}`);
    $('export-options').classList.add('hidden');
  });
});

// Clear collection
$('btn-clear').addEventListener('click', () => {
  if (cards.length === 0) return;
  if (confirm('Tem a certeza? Todas as cartas serão removidas.')) {
    cards = [];
    saveCards();
    renderCollection();
    toast('Coleção limpa');
  }
});

// Help
$('btn-help').addEventListener('click', () => {
  $('input-api-key').value = getApiKey();
  $('api-key-status').classList.add('hidden');
  openPanel('panel-help');
});
$('close-help').addEventListener('click', closeAllPanels);

$('btn-save-key').addEventListener('click', () => {
  const key = $('input-api-key').value.trim();
  if (!key) { toast('Insere uma API key válida'); return; }
  setApiKey(key);
  const status = $('api-key-status');
  status.classList.remove('hidden');
  status.textContent = '✅ API key guardada com sucesso!';
  status.style.color = 'var(--accent2)';
  toast('🔑 API key do OCR.space guardada');
});

// Privacy
$('btn-accept-privacy').addEventListener('click', () => {
  localStorage.setItem(PRIVACY_KEY, 'true');
  $('privacy-overlay').classList.add('hidden');
});

// JSON export/import
$('btn-export-json').addEventListener('click', exportJSON);
$('file-import-json').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importJSON(file);
  e.target.value = '';
});

// Load version
fetch('version.json')
  .then(r => r.json())
  .then(v => { const el = $('app-version'); if (el) el.textContent = v.version; })
  .catch(() => {});

// ─── Init ─────────────────────────────────────────────────
async function init() {
  loadCards();
  renderCollection();
  checkPrivacy();

  if (!getApiKey()) {
    setTimeout(() => toast('🔑 Configura a API key do OCR.space na Ajuda', 4000), 1500);
  }

  await initCamera();

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('SW registered');
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('New SW installed, reloading...');
            window.location.reload();
          }
        });
      });
    } catch (e) {
      console.log('SW registration failed:', e);
    }
  }

  console.log('PokéScanner ready');
}

// Listen for SW lifecycle messages
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'SW_UPDATED') {
      console.log('SW updated, reloading...');
      window.location.reload();
    }
  });
}

init();
