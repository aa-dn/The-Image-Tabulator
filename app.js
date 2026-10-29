'use strict';

const IMAGE_EXT = new Set(['jpg','jpeg','png','gif','webp','bmp','avif']);
const THUMB_SIZE = 512;        // short-side px of generated thumbnails (big enough for the enlarged view)
const THUMB_CONCURRENCY = 4;   // how many images to decode at once
const PEEK_SCALE = 2.3;        // keep in sync with .thumb.peek transform in style.css
const BATCH_THRESHOLD = 300;   // folders with more photos than this are reviewed in batches
const SCAN_CHUNK = 64;         // files read in parallel while scanning a folder
const PAGE_SIZES = [0, 100, 200, 500]; // 0 = show all
const PREFS_KEY = 'photo-sorter:prefs';
const SIDEBAR_MIN = 180, SIDEBAR_MAX = 560, SIDEBAR_DEFAULT = 240; // px

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);
const SORTERS = {
  'name':      byName,
  'date-asc':  (a, b) => a.lastModified - b.lastModified || byName(a, b),
  'date-desc': (a, b) => b.lastModified - a.lastModified || byName(a, b),
  'size-desc': (a, b) => b.size - a.size || byName(a, b),
};

const state = {
  dirHandle: null,
  dirName: '',
  photos: [],             // kept sorted by state.sort
  photoMap: new Map(),
  groups: new Map(),      // key(lowercase) -> {name, series}; insertion order = hotkey order
  selection: new Set(),   // photo keys
  anchorKey: null,
  activeFilter: 'all',    // 'all' | 'ungrouped' | group key
  search: '',
  lightboxPhoto: null,
  lightboxIndex: 0,       // position of lightboxPhoto in the visible list when it was shown
  page: 0,
  pageList: [],           // photos currently rendered in the grid
  sort: 'name',
  pageSize: 200,
  thumbSize: 150,         // minimum thumbnail width in px
  sidebarWidth: SIDEBAR_DEFAULT,
  progressScope: 'batch', // grouped-counter scope: 'batch' | 'all'
};

let observer = null;

// ---------------- IndexedDB (stores the last-used folder handle) ----------------

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('photo-sorter-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------- Persistence of groups (per folder, in localStorage) ----------------

function storageKey() {
  return `photo-sorter:data:${state.dirName}`;
}
function persistGroups() {
  if (!state.dirName) return;
  const assignments = {};
  state.photos.forEach(p => { if (p.groups.size) assignments[p.key] = [...p.groups]; });
  const groups = [...state.groups.entries()].map(([key, g]) => ({ key, name: g.name, series: g.series }));
  localStorage.setItem(storageKey(), JSON.stringify({ groups, assignments }));
}
function loadPersistedGroups() {
  state.groups.clear();
  const raw = localStorage.getItem(storageKey());
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    (data.groups || []).forEach(g => state.groups.set(g.key, { name: g.name, series: g.series }));
    const assignments = data.assignments || {};
    for (const [key, groupKeys] of Object.entries(assignments)) {
      const photo = state.photoMap.get(key);
      if (photo) groupKeys.forEach(gk => { if (state.groups.has(gk)) photo.groups.add(gk); });
    }
  } catch (e) {
    console.warn('Could not read saved groups for this folder', e);
  }
}

// ---------------- View preferences (sort, batch size, thumbnail size) ----------------

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (SORTERS[p.sort]) state.sort = p.sort;
    if (PAGE_SIZES.includes(p.pageSize)) state.pageSize = p.pageSize;
    if (p.progressScope === 'batch' || p.progressScope === 'all') state.progressScope = p.progressScope;
    if (p.thumbSize >= 90 && p.thumbSize <= 260) state.thumbSize = p.thumbSize;
    if (p.sidebarWidth >= SIDEBAR_MIN && p.sidebarWidth <= SIDEBAR_MAX) state.sidebarWidth = p.sidebarWidth;
  } catch (e) { /* defaults are fine */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      sort: state.sort, pageSize: state.pageSize, thumbSize: state.thumbSize, sidebarWidth: state.sidebarWidth,
      progressScope: state.progressScope,
    }));
  } catch (e) { /* not critical */ }
}

// ---------------- Resizable sidebar ----------------

function applySidebarWidth() {
  // Never let the sidebar take more than half the window, however wide it was saved.
  const w = Math.min(state.sidebarWidth, Math.max(SIDEBAR_MIN, Math.floor(window.innerWidth / 2)));
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
}

function setSidebarWidth(px) {
  state.sidebarWidth = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
  applySidebarWidth();
}

function wireSidebarResizer() {
  const handle = document.getElementById('sidebar-resizer');
  const sidebar = document.querySelector('.sidebar');
  let startX = 0, startW = 0;

  const onMove = (e) => setSidebarWidth(startW + (e.clientX - startX));
  const onUp = () => {
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-sidebar');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    savePrefs();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('resizing-sidebar');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('dblclick', () => { setSidebarWidth(SIDEBAR_DEFAULT); savePrefs(); });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowLeft') setSidebarWidth(state.sidebarWidth - step);
    else if (e.key === 'ArrowRight') setSidebarWidth(state.sidebarWidth + step);
    else return;
    e.preventDefault();
    savePrefs();
  });
  window.addEventListener('resize', applySidebarWidth);
  applySidebarWidth();
}

// ---------------- Folder loading ----------------

async function openFolder() {
  try {
    const handle = await window.showDirectoryPicker();
    await idbSet('lastDir', handle);
    await loadFolder(handle);
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
}

async function tryRestoreLastFolder() {
  let handle;
  try {
    handle = await idbGet('lastDir');
  } catch (e) { return; }
  if (!handle) return;
  let perm;
  try {
    perm = await handle.queryPermission({ mode: 'read' });
  } catch (e) { return; }
  if (perm === 'granted') {
    await loadFolder(handle);
  } else {
    const btn = document.getElementById('btn-reopen');
    btn.textContent = `Reopen "${handle.name}"`;
    btn.classList.remove('hidden');
    btn.onclick = async () => {
      try {
        const p = await handle.requestPermission({ mode: 'read' });
        if (p === 'granted') await loadFolder(handle);
      } catch (e) { console.error(e); }
    };
  }
}

async function loadFolder(handle, { preserveView = false } = {}) {
  const prev = preserveView
    ? { filter: state.activeFilter, search: state.search, selection: new Set(state.selection), page: state.page }
    : null;

  state.dirHandle = handle;
  state.dirName = handle.name;

  revokeAllObjectUrls();
  thumbQueue.length = 0;

  const status = document.getElementById('folder-name');
  status.textContent = `Scanning ${handle.name}…`;

  const entries = [];
  for await (const [name, h] of handle.entries()) {
    if (h.kind !== 'file') continue;
    const ext = name.split('.').pop().toLowerCase();
    if (IMAGE_EXT.has(ext)) entries.push([name, h]);
  }

  // Reading file metadata one at a time is slow for thousands of files, so do it in parallel chunks.
  const photos = [];
  for (let i = 0; i < entries.length; i += SCAN_CHUNK) {
    const chunk = await Promise.all(entries.slice(i, i + SCAN_CHUNK).map(async ([name, h]) => {
      let file;
      try {
        file = await h.getFile();
      } catch (e) { return null; }
      return {
        key: `${name}::${file.size}`,
        name,
        handle: h,
        size: file.size,
        lastModified: file.lastModified,
        groups: new Set(),
        objectUrl: null,   // full-size, used by the lightbox
        thumbUrl: null,    // downscaled, used by the grid
        thumbPending: false,
        width: null,
        height: null,
      };
    }));
    chunk.forEach(p => { if (p) photos.push(p); });
    status.textContent = `Scanning ${handle.name}… ${Math.min(i + SCAN_CHUNK, entries.length)} / ${entries.length}`;
  }

  state.photos = photos;
  applySort();
  state.photoMap = new Map(photos.map(p => [p.key, p]));
  state.selection.clear();
  state.anchorKey = null;
  state.activeFilter = 'all';
  state.search = '';
  state.page = 0;

  loadPersistedGroups();

  // On rescan, keep the user's place: same group filter, search text, batch and still-present selection.
  if (prev) {
    if (prev.filter === 'all' || prev.filter === 'ungrouped' || state.groups.has(prev.filter)) {
      state.activeFilter = prev.filter;
    }
    state.search = prev.search;
    state.page = prev.page;
    prev.selection.forEach(k => { if (state.photoMap.has(k)) state.selection.add(k); });
  }

  status.textContent = `${handle.name} (${photos.length.toLocaleString()} photo${photos.length === 1 ? '' : 's'})`;
  document.getElementById('btn-reopen').classList.add('hidden');
  document.getElementById('btn-rescan').classList.remove('hidden');
  document.getElementById('search').value = state.search;
  setSearchOpen(!!state.search);
  document.getElementById('add-group-dropdown').classList.remove('hidden');
  document.getElementById('btn-remove-group').classList.remove('hidden');
  document.getElementById('btn-clear-selection').classList.remove('hidden');
  document.getElementById('btn-stats').classList.remove('hidden');
  document.getElementById('intro-message').classList.add('hidden');
  document.getElementById('layout').classList.remove('hidden');

  renderAll();
}

function revokeAllObjectUrls() {
  state.photos.forEach(p => {
    if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
    if (p.thumbUrl && p.thumbUrl !== p.objectUrl) URL.revokeObjectURL(p.thumbUrl);
  });
}

// ---------------- Thumbnails ----------------
// Full-size photos are decoded once, drawn onto a small canvas and kept as a
// compact JPEG, so a grid of hundreds of large photos stays light on memory.

const thumbQueue = [];
let thumbActive = 0;

function requestThumb(photo) {
  if (photo.thumbUrl || photo.thumbPending) return;
  photo.thumbPending = true;
  thumbQueue.push(photo);
  pumpThumbQueue();
}

function pumpThumbQueue() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const photo = thumbQueue.shift();
    thumbActive++;
    makeThumb(photo)
      .then(url => {
        photo.thumbUrl = url;
        // The grid may have been re-rendered since the request, so look the cell up fresh.
        const img = document.querySelector(`#grid .thumb[data-key="${CSS.escape(photo.key)}"] img`);
        if (img) img.src = url;
      })
      .catch(() => {})
      .finally(() => {
        photo.thumbPending = false;
        thumbActive--;
        pumpThumbQueue();
      });
  }
}

async function makeThumb(photo) {
  const file = await photo.handle.getFile();
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (e) {
    // Format the bitmap decoder can't handle — fall back to the original file.
    if (!photo.objectUrl) photo.objectUrl = URL.createObjectURL(file);
    return photo.objectUrl;
  }
  photo.width = bmp.width;
  photo.height = bmp.height;
  const scale = Math.min(1, THUMB_SIZE / Math.min(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  // GIFs/PNGs may have transparency; keep it by using PNG for those.
  const type = /\.(png|gif)$/i.test(photo.name) ? 'image/png' : 'image/jpeg';
  const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.85));
  if (!blob) throw new Error('thumbnail encode failed');
  return URL.createObjectURL(blob);
}

// ---------------- Derived data ----------------

function applySort() {
  state.photos.sort(SORTERS[state.sort]);
}

function computeCounts() {
  const byGroup = {};
  let ungrouped = 0;
  state.photos.forEach(p => {
    if (p.groups.size === 0) ungrouped++;
    p.groups.forEach(gk => { byGroup[gk] = (byGroup[gk] || 0) + 1; });
  });
  return { total: state.photos.length, ungrouped, byGroup };
}

function getVisibleList() {
  let list = state.photos;
  if (state.activeFilter === 'ungrouped') list = list.filter(p => p.groups.size === 0);
  else if (state.activeFilter !== 'all') list = list.filter(p => p.groups.has(state.activeFilter));
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(q));
  }
  return list;
}

// ---------------- Batches ----------------
// Large folders are split into fixed-size batches so the grid stays fast and
// the user can work through them one screenful at a time.

function batchingActive() {
  return state.photos.length > BATCH_THRESHOLD && state.pageSize > 0;
}
function pageCount(list) {
  return batchingActive() ? Math.max(1, Math.ceil(list.length / state.pageSize)) : 1;
}
function pageSlice(list) {
  if (!batchingActive()) return list;
  const start = state.page * state.pageSize;
  return list.slice(start, start + state.pageSize);
}
function goToPage(n) {
  state.page = n;
  renderGrid();
  document.getElementById('grid-scroll').scrollTop = 0;
}
function stepPage(delta) {
  const pages = pageCount(getVisibleList());
  const next = state.page + delta;
  if (next >= 0 && next < pages) goToPage(next);
}

// ---------------- Groups ----------------

// The first nine groups (in creation order) can be applied with the 1–9 keys.
function hotkeyGroups() {
  return [...state.groups.keys()].slice(0, 9);
}

function createGroup(rawName) {
  const name = rawName.trim();
  if (!name) return null;
  const key = name.toLowerCase();
  if (!state.groups.has(key)) {
    state.groups.set(key, { name, series: leastUsedSeries() });
  }
  return key;
}

// Pick the colour used by the fewest groups, so deleting groups doesn't lead to repeats.
function leastUsedSeries() {
  const used = new Array(9).fill(0);
  state.groups.forEach(g => { used[g.series]++; });
  let best = 1;
  for (let s = 2; s <= 8; s++) if (used[s] < used[best]) best = s;
  return best;
}

function groupsChanged() {
  persistGroups();
  renderGroupSidebar();
  renderGrid();
  renderStatsIfOpen();
  if (state.lightboxPhoto) {
    renderLightboxGroups();
    updateLightboxCaption(state.lightboxPhoto);
  }
}

function addSelectionToGroup(key) {
  if (!key || state.selection.size === 0) return;
  state.selection.forEach(pk => {
    const photo = state.photoMap.get(pk);
    if (photo) photo.groups.add(key);
  });
  groupsChanged();
}

function removeSelectionFromGroup(key) {
  if (!key || state.selection.size === 0) return;
  state.selection.forEach(pk => {
    const photo = state.photoMap.get(pk);
    if (photo) photo.groups.delete(key);
  });
  groupsChanged();
}

function togglePhotoGroup(photo, key) {
  if (!photo || !key) return;
  if (photo.groups.has(key)) photo.groups.delete(key);
  else photo.groups.add(key);
  groupsChanged();
}

function renameGroup(oldKey, rawNewName) {
  const newName = rawNewName.trim();
  if (!newName) return;
  const newKey = newName.toLowerCase();
  const info = state.groups.get(oldKey);
  if (!info) return;
  if (newKey === oldKey) {
    info.name = newName;
  } else {
    if (state.groups.has(newKey)) {
      // merge into existing group
      state.groups.delete(oldKey);
    } else {
      // Rebuild the map so the group keeps its position (and so its hotkey).
      const rebuilt = new Map();
      state.groups.forEach((g, k) => {
        if (k === oldKey) rebuilt.set(newKey, { name: newName, series: info.series });
        else rebuilt.set(k, g);
      });
      state.groups = rebuilt;
    }
    state.photos.forEach(p => {
      if (p.groups.has(oldKey)) { p.groups.delete(oldKey); p.groups.add(newKey); }
    });
    if (state.activeFilter === oldKey) state.activeFilter = newKey;
  }
  persistGroups();
  renderAll();
}

function deleteGroup(key) {
  state.groups.delete(key);
  state.photos.forEach(p => p.groups.delete(key));
  if (state.activeFilter === key) state.activeFilter = 'all';
  persistGroups();
  renderAll();
}

// ---------------- Selection ----------------

function toggleOne(key) {
  if (state.selection.has(key)) state.selection.delete(key);
  else state.selection.add(key);
  state.anchorKey = key;
  updateSelectionUI();
}

// A plain click toggles a photo in/out of the selection (no Ctrl needed);
// Shift-click adds every photo between the last clicked one and this one.
function handleThumbClick(e, photo, visibleList) {
  const key = photo.key;
  if (e.shiftKey && state.anchorKey) {
    const idxA = visibleList.findIndex(p => p.key === state.anchorKey);
    const idxB = visibleList.findIndex(p => p.key === key);
    if (idxA !== -1 && idxB !== -1) {
      const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
      for (let i = lo; i <= hi; i++) state.selection.add(visibleList[i].key);
      state.anchorKey = key;
      updateSelectionUI();
      return;
    }
  }
  toggleOne(key);
}

function clearSelection() {
  state.selection.clear();
  updateSelectionUI();
}

// Selects everything in the current batch (or the whole view when not batching).
function selectAllVisible() {
  state.pageList.forEach(p => state.selection.add(p.key));
  updateSelectionUI();
}

function updateSelectionUI() {
  document.querySelectorAll('#grid .thumb').forEach(cell => {
    const key = cell.dataset.key;
    const sel = state.selection.has(key);
    cell.classList.toggle('selected', sel);
    const cb = cell.querySelector('.thumb-check input');
    if (cb) cb.checked = sel;
  });
  const n = state.selection.size;
  document.getElementById('selection-count').textContent = n ? `${n.toLocaleString()} selected` : '';
  document.getElementById('btn-add-group').disabled = n === 0;
  document.getElementById('btn-clear-selection').disabled = n === 0;
  document.getElementById('btn-remove-group').disabled = !(n > 0 && state.activeFilter !== 'all' && state.activeFilter !== 'ungrouped');
}

// ---------------- Rendering: grid ----------------

function ensureObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      observer.unobserve(el);
      const photo = state.photoMap.get(el.dataset.key);
      if (photo) requestThumb(photo);
    });
  }, { root: document.getElementById('grid-scroll'), rootMargin: '600px 0px' });
  return observer;
}

// The zoomed thumbnail would be clipped by the scroll area (or hidden under the
// sticky view bar) at its edges, so anchor the zoom to whichever edge is close.
function setZoomOrigin(cell) {
  const img = cell.querySelector('img');
  if (!img) return;
  const c = cell.getBoundingClientRect();
  const s = document.getElementById('grid-scroll').getBoundingClientRect();
  const top = Math.max(s.top, document.getElementById('viewbar').getBoundingClientRect().bottom);
  const growX = c.width * (PEEK_SCALE - 1) / 2;
  const growY = c.height * (PEEK_SCALE - 1) / 2;
  let x = 'center', y = 'center';
  if (c.left - growX < s.left) x = 'left';
  else if (c.right + growX > s.right) x = 'right';
  if (c.top - growY < top) y = 'top';
  else if (c.bottom + growY > s.bottom) y = 'bottom';
  img.style.transformOrigin = `${x} ${y}`;
}

function chipHtml(groupKey) {
  const g = state.groups.get(groupKey);
  if (!g) return '';
  return `<span class="chip" data-series="${g.series}">${escapeHtml(g.name)}</span>`;
}

function renderGrid() {
  const full = getVisibleList();
  const pages = pageCount(full);
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  const list = pageSlice(full);
  state.pageList = list;

  renderViewbar(full, pages);

  // Drop thumbnails queued for the previous view so the new one loads first.
  thumbQueue.forEach(p => { p.thumbPending = false; });
  thumbQueue.length = 0;

  const grid = document.getElementById('grid');
  const emptyMsg = document.getElementById('empty-message');
  grid.innerHTML = '';
  emptyMsg.classList.toggle('hidden', list.length > 0);

  const frag = document.createDocumentFragment();
  const obs = ensureObserver();

  list.forEach(photo => {
    const cell = document.createElement('div');
    cell.className = 'thumb' + (state.selection.has(photo.key) ? ' selected' : '');
    cell.dataset.key = photo.key;

    const chips = [...photo.groups].map(chipHtml).join('');

    cell.innerHTML = `
      <div class="thumb-inner">
        <img alt="${escapeHtml(photo.name)}" ${photo.thumbUrl ? `src="${photo.thumbUrl}"` : ''} />
        <div class="thumb-overlay">
          <label class="thumb-check"><input type="checkbox" ${state.selection.has(photo.key) ? 'checked' : ''} /></label>
          <div class="thumb-name">${escapeHtml(photo.name)}</div>
        </div>
        <div class="thumb-chips">${chips}</div>
      </div>`;

    frag.appendChild(cell);
  });

  grid.appendChild(frag);
  // Observe after insertion so layout is settled.
  grid.querySelectorAll('.thumb').forEach(cell => {
    if (!state.photoMap.get(cell.dataset.key)?.thumbUrl) obs.observe(cell);
  });
  updateSelectionUI();
}

// Grid events are delegated from #grid so re-rendering a batch doesn't attach
// hundreds of listeners each time.
function wireGridEvents() {
  const grid = document.getElementById('grid');
  const photoFor = (e) => {
    const cell = e.target.closest('.thumb');
    return cell ? state.photoMap.get(cell.dataset.key) : null;
  };
  grid.addEventListener('click', (e) => {
    const photo = photoFor(e);
    if (!photo) return;
    if (e.target.closest('.thumb-check')) {
      // Clicking the label's padding would otherwise re-fire the click on its checkbox.
      if (e.target.tagName !== 'INPUT') e.preventDefault();
      toggleOne(photo.key);
      return;
    }
    handleThumbClick(e, photo, state.pageList);
  });
  grid.addEventListener('dblclick', (e) => {
    if (e.target.closest('.thumb-check')) return;
    const photo = photoFor(e);
    if (photo) openLightbox(photo);
  });
  // Hold the right mouse button on a photo to enlarge it; release to shrink it back.
  grid.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    const cell = e.target.closest('.thumb');
    if (!cell) return;
    e.preventDefault();
    setZoomOrigin(cell);
    cell.classList.add('peek');
  });
  grid.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.thumb')) e.preventDefault();
  });
  const endPeek = () => document.querySelectorAll('#grid .thumb.peek').forEach(c => c.classList.remove('peek'));
  window.addEventListener('mouseup', (e) => { if (e.button === 2) endPeek(); });
  window.addEventListener('blur', endPeek);
}

// ---------------- Rendering: view bar (sort, size, batches, progress) ----------------

function renderViewbar(full, pages) {
  const big = state.photos.length > BATCH_THRESHOLD;
  document.getElementById('page-size-wrap').classList.toggle('hidden', !big);

  const pager = document.getElementById('pager');
  pager.classList.toggle('hidden', !batchingActive() || pages <= 1);
  if (batchingActive() && pages > 1) {
    const size = state.pageSize;
    const opts = [];
    for (let i = 0; i < pages; i++) {
      const slice = full.slice(i * size, (i + 1) * size);
      const done = slice.every(p => p.groups.size > 0);
      const from = i * size + 1, to = i * size + slice.length;
      opts.push(`<option value="${i}"${i === state.page ? ' selected' : ''}>Batch ${i + 1} of ${pages} · ${from.toLocaleString()}–${to.toLocaleString()}${done ? ' ✓' : ''}</option>`);
    }
    document.getElementById('page-select').innerHTML = opts.join('');
    document.getElementById('btn-prev-page').disabled = state.page === 0;
    document.getElementById('btn-next-page').disabled = state.page >= pages - 1;
  }

  // The counter shows either the current batch or every photo in the folder.
  const multiBatch = batchingActive() && pages > 1;
  const toggle = document.getElementById('scope-toggle');
  toggle.classList.toggle('hidden', !multiBatch);
  const scope = multiBatch ? state.progressScope : 'all';
  toggle.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scope === scope)));

  const counted = scope === 'batch' ? state.pageList : state.photos;
  const total = counted.length;
  const grouped = counted.reduce((n, p) => n + (p.groups.size ? 1 : 0), 0);
  const pct = total ? Math.round((grouped / total) * 100) : 0;
  let text = `${grouped.toLocaleString()} of ${total.toLocaleString()} grouped`;
  text += scope === 'batch' ? ` in this batch (${pct}%)` : ` (${pct}%)`;
  if (scope === 'batch' && total && grouped === total) text += ' ✓';
  document.getElementById('progress-text').textContent = text;
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

function applyThumbSize() {
  document.getElementById('grid').style.setProperty('--thumb-min', `${state.thumbSize}px`);
}

// ---------------- Rendering: sidebar ----------------

function renderGroupSidebar() {
  const counts = computeCounts();
  const container = document.getElementById('group-list');
  const hotkeys = hotkeyGroups();

  const rows = [];
  rows.push(groupRowHtml('all', 'All photos', counts.total, null, state.activeFilter === 'all', false, 0));
  rows.push(groupRowHtml('ungrouped', 'Ungrouped', counts.ungrouped, null, state.activeFilter === 'ungrouped', false, 0));

  [...state.groups.entries()]
    .sort((a, b) => (counts.byGroup[b[0]] || 0) - (counts.byGroup[a[0]] || 0))
    .forEach(([key, g]) => {
      rows.push(groupRowHtml(key, g.name, counts.byGroup[key] || 0, g.series, state.activeFilter === key, true, hotkeys.indexOf(key) + 1));
    });

  container.innerHTML = rows.join('');

  container.querySelectorAll('.group-row').forEach(row => {
    const key = row.dataset.key;
    row.querySelector('.group-row-main').addEventListener('click', () => {
      state.activeFilter = key;
      state.page = 0;
      renderAll();
      document.getElementById('grid-scroll').scrollTop = 0;
    });
    const nameEl = row.querySelector('.group-row-name');
    const delBtn = row.querySelector('.group-row-delete');
    if (nameEl && key !== 'all' && key !== 'ungrouped') {
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const current = state.groups.get(key);
        const name = prompt('Rename group', current ? current.name : '');
        if (name !== null) renameGroup(key, name);
      });
    }
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const g = state.groups.get(key);
        if (confirm(`Delete group "${g ? g.name : key}"? Photos in it will become ungrouped.`)) {
          deleteGroup(key);
        }
      });
    }
  });
}

function groupRowHtml(key, name, count, series, active, deletable, hotkey) {
  const swatch = series
    ? `<span class="group-swatch" data-series="${series}"></span>`
    : `<span class="group-swatch"></span>`;
  return `
    <div class="group-row${active ? ' active' : ''}" data-key="${escapeAttr(key)}">
      <div class="group-row-main">
        ${swatch}
        <span class="group-row-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
        ${hotkey ? `<kbd class="hotkey" title="Press ${hotkey} to add selected photos to this group">${hotkey}</kbd>` : ''}
        <span class="group-row-count">${count.toLocaleString()}</span>
      </div>
      ${deletable ? `<button class="group-row-delete" title="Delete group">✕</button>` : ''}
    </div>`;
}

// ---------------- Add-to-group dropdown ----------------

function renderAddGroupMenu() {
  const list = document.getElementById('existing-groups-list');
  const hotkeys = hotkeyGroups();
  const entries = [...state.groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  if (entries.length === 0) {
    list.innerHTML = `<div class="dropdown-empty">No groups yet — create one below.</div>`;
  } else {
    list.innerHTML = entries.map(([key, g]) => {
      const hk = hotkeys.indexOf(key) + 1;
      return `
      <div class="dropdown-item" data-key="${escapeAttr(key)}">
        <span class="group-swatch" data-series="${g.series}"></span>
        <span class="dropdown-item-name">${escapeHtml(g.name)}</span>
        ${hk ? `<kbd class="hotkey">${hk}</kbd>` : ''}
      </div>`;
    }).join('');
  }
  list.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      addSelectionToGroup(item.dataset.key);
      closeDropdown();
    });
  });
}

// Right-align the menu under its button, but slide it back inside the window
// when the button sits near an edge (e.g. after the toolbar wraps).
function positionDropdownMenu() {
  const dropdown = document.getElementById('add-group-dropdown');
  if (!dropdown.classList.contains('open')) return;
  const r = document.getElementById('btn-add-group').getBoundingClientRect();
  const menu = document.getElementById('add-group-menu');
  const margin = 8;
  const w = menu.offsetWidth;
  const left = Math.max(margin, Math.min(r.right - w, window.innerWidth - w - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 6 - margin)}px`;
}

function closeDropdown() {
  document.getElementById('add-group-dropdown').classList.remove('open');
}

// ---------------- Stats ----------------

function renderStatsIfOpen() {
  if (document.getElementById('stats-modal').classList.contains('open')) updateStats();
}

function updateStats() {
  const counts = computeCounts();
  setText('stat-total', counts.total.toLocaleString());
  setText('stat-groups', state.groups.size);
  const grouped = counts.total - counts.ungrouped;
  setText('stat-grouped', grouped.toLocaleString());
  setText('stat-ungrouped', counts.ungrouped.toLocaleString());
  const avg = state.groups.size ? (grouped / state.groups.size) : 0;
  setText('stat-avg', avg.toFixed(1));

  let largest = null;
  for (const [key, g] of state.groups.entries()) {
    const c = counts.byGroup[key] || 0;
    if (!largest || c > largest.count) largest = { name: g.name, count: c };
  }
  setText('stat-largest', largest && largest.count > 0 ? `${largest.name} (${largest.count.toLocaleString()})` : '—');

  const rows = [...state.groups.entries()].map(([key, g]) => ({
    key, name: g.name, series: g.series, count: counts.byGroup[key] || 0,
  }));
  rows.push({ key: 'ungrouped', name: 'Ungrouped', series: null, count: counts.ungrouped });
  rows.sort((a, b) => b.count - a.count);

  const max = Math.max(1, ...rows.map(r => r.count));
  const chart = document.getElementById('stats-chart');
  chart.innerHTML = rows.map(r => {
    const pct = (r.count / max) * 100;
    const share = counts.total ? Math.round((r.count / counts.total) * 100) : 0;
    return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(r.name)}</div>
        <div class="bar-track"><div class="bar-fill" data-series="${r.series ?? 'muted'}" style="width:${pct}%"></div></div>
        <div class="bar-value">${r.count.toLocaleString()} <span class="bar-pct">(${share}%)</span></div>
      </div>`;
  }).join('');

  const tbody = document.getElementById('stats-table-body');
  tbody.innerHTML = rows.map(r => {
    const share = counts.total ? Math.round((r.count / counts.total) * 100) : 0;
    return `<tr>
      <td><span class="swatch" data-series="${r.series ?? 'muted'}"></span>${escapeHtml(r.name)}</td>
      <td class="num">${r.count.toLocaleString()}</td>
      <td class="num">${share}%</td>
    </tr>`;
  }).join('');
}

function exportCsv() {
  const csvCell = v => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['filename', 'size_bytes', 'groups'].join(',')];
  state.photos.forEach(p => {
    const names = [...p.groups].map(gk => state.groups.get(gk)?.name).filter(Boolean).join('; ');
    lines.push([p.name, p.size, names].map(csvCell).join(','));
  });
  // BOM so Excel opens non-ASCII filenames correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.dirName || 'photos'}-groups.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openStats() {
  updateStats();
  document.getElementById('stats-modal').classList.add('open');
}
function closeStats() {
  document.getElementById('stats-modal').classList.remove('open');
}

// ---------------- Lightbox ----------------
// The lightbox steps through the whole filtered view (across batches), and
// 1–9 toggle the shown photo in/out of groups, so a large folder can be
// triaged one photo at a time from the keyboard.

function openLightbox(photo) {
  const index = getVisibleList().indexOf(photo);
  document.getElementById('lightbox').classList.add('open');
  showInLightbox(photo, Math.max(0, index));
}

function showInLightbox(photo, index) {
  state.lightboxPhoto = photo;
  state.lightboxIndex = index;
  renderLightboxImage(photo, document.getElementById('lightbox-img'));
  renderLightboxGroups();
}

function renderLightboxImage(photo, img) {
  img.onload = () => {
    photo.width = img.naturalWidth;
    photo.height = img.naturalHeight;
    if (state.lightboxPhoto === photo) updateLightboxCaption(photo);
  };
  if (photo.objectUrl) {
    img.src = photo.objectUrl;
  } else {
    img.removeAttribute('src');
    photo.handle.getFile().then(file => {
      photo.objectUrl = URL.createObjectURL(file);
      if (state.lightboxPhoto === photo) img.src = photo.objectUrl;
    }).catch(() => {});
  }
  updateLightboxCaption(photo);
}

function updateLightboxCaption(photo) {
  const list = getVisibleList();
  const idx = list.indexOf(photo);
  const pos = idx !== -1 ? `${(idx + 1).toLocaleString()} / ${list.length.toLocaleString()} · ` : '';
  const dims = photo.width ? ` · ${photo.width}×${photo.height}` : '';
  document.getElementById('lightbox-caption').textContent = `${pos}${photo.name} · ${formatBytes(photo.size)}${dims}`;
}

function renderLightboxGroups() {
  const box = document.getElementById('lightbox-groups');
  const photo = state.lightboxPhoto;
  if (!photo) return;
  const hotkeys = hotkeyGroups();
  if (state.groups.size === 0) {
    box.innerHTML = `<span class="lightbox-hint">Create a group first (Add to group ▾), then press 1–9 here to tag photos.</span>`;
    return;
  }
  const buttons = [...state.groups.entries()].map(([key, g]) => {
    const hk = hotkeys.indexOf(key) + 1;
    return `<button class="lb-group${photo.groups.has(key) ? ' on' : ''}" data-key="${escapeAttr(key)}">
      ${hk ? `<kbd>${hk}</kbd>` : ''}<span class="group-swatch" data-series="${g.series}"></span>${escapeHtml(g.name)}
    </button>`;
  }).join('');
  box.innerHTML = `${buttons}<span class="lightbox-hint">1–9 toggle · ← → move · Esc close</span>`;
}

function closeLightbox() {
  const photo = state.lightboxPhoto;
  document.getElementById('lightbox').classList.remove('open');
  state.lightboxPhoto = null;
  if (!photo) return;
  // Return to the batch containing the last photo viewed.
  if (batchingActive()) {
    const idx = getVisibleList().indexOf(photo);
    if (idx !== -1) {
      const page = Math.floor(idx / state.pageSize);
      if (page !== state.page) { state.page = page; renderGrid(); }
    }
  }
  const cell = document.querySelector(`#grid .thumb[data-key="${CSS.escape(photo.key)}"]`);
  if (cell) cell.scrollIntoView({ block: 'nearest' });
}

function lightboxStep(delta) {
  if (!state.lightboxPhoto) return;
  const list = getVisibleList();
  if (!list.length) { closeLightbox(); return; }
  const idx = list.indexOf(state.lightboxPhoto);
  let target;
  if (idx === -1) {
    // The photo left the view (e.g. it was just grouped while viewing "Ungrouped"):
    // the next photo has slid into its old position.
    const base = Math.min(state.lightboxIndex, list.length);
    target = delta > 0 ? base : base - 1;
  } else {
    target = idx + delta;
  }
  target = (target + list.length) % list.length;
  showInLightbox(list[target], target);
}

// ---------------- Utilities ----------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
function setText(id, value) { document.getElementById(id).textContent = value; }
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function renderAll() {
  renderGroupSidebar();
  renderGrid();
  renderAddGroupMenu();
  renderStatsIfOpen();
}

// ---------------- Intro bird spin (first visit only) ----------------

function spinIntroLogoOnFirstVisit() {
  try {
    if (localStorage.getItem('photo-sorter:intro-spun')) return;
    localStorage.setItem('photo-sorter:intro-spun', '1');
  } catch {
    return; // storage blocked: we can't tell if it's the first visit, so skip it
  }
  document.querySelector('#intro-message .intro-logo').classList.add('spin-once');
}

// ---------------- Wire up ----------------

function wireViewbar() {
  const sortSel = document.getElementById('sort-select');
  const sizeRange = document.getElementById('thumb-size');
  const pageSizeSel = document.getElementById('page-size-select');

  sortSel.value = state.sort;
  sizeRange.value = state.thumbSize;
  pageSizeSel.value = String(state.pageSize);
  applyThumbSize();

  document.getElementById('scope-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn || btn.dataset.scope === state.progressScope) return;
    state.progressScope = btn.dataset.scope;
    savePrefs();
    renderViewbar(getVisibleList(), pageCount(getVisibleList()));
  });

  sortSel.addEventListener('change', () => {
    state.sort = sortSel.value;
    applySort();
    savePrefs();
    sortSel.blur();
    goToPage(0);
  });
  sizeRange.addEventListener('input', () => {
    state.thumbSize = Number(sizeRange.value);
    applyThumbSize();
  });
  sizeRange.addEventListener('change', () => { savePrefs(); sizeRange.blur(); });
  pageSizeSel.addEventListener('change', () => {
    // Keep the first photo of the current batch in view when the batch size changes.
    const firstIndex = batchingActive() ? state.page * state.pageSize : 0;
    state.pageSize = Number(pageSizeSel.value);
    savePrefs();
    pageSizeSel.blur();
    goToPage(state.pageSize ? Math.floor(firstIndex / state.pageSize) : 0);
  });

  const pageSel = document.getElementById('page-select');
  pageSel.addEventListener('change', () => { goToPage(Number(pageSel.value)); pageSel.blur(); });
  document.getElementById('btn-prev-page').addEventListener('click', () => stepPage(-1));
  document.getElementById('btn-next-page').addEventListener('click', () => stepPage(1));
}

// ---------------- Stacked title ----------------

// Lay out "THE / IMAGE / TABULATOR" as a justified block `width` px wide:
// the later words are sized to fill the width exactly; the first word is set at
// the same size as the second and letter-spaced out to the full width.
function fitBlockTitle(el, width) {
  if (!el) return;
  el.style.gap = `${Math.round(width * 0.06)}px`;
  const [first, ...rest] = el.querySelectorAll(':scope > span');
  const fitWidth = (span) => {
    span.style.letterSpacing = '';
    span.style.marginRight = '';
    span.style.fontSize = '100px';
    const w = span.getBoundingClientRect().width;
    const size = w ? 100 * width / w : 0;
    span.style.fontSize = `${size.toFixed(2)}px`;
    return size;
  };
  const [secondSize] = rest.map(fitWidth);
  if (!secondSize) return; // hidden; fitted again when shown

  first.style.letterSpacing = '';
  first.style.marginRight = '';
  first.style.fontSize = `${secondSize.toFixed(2)}px`;
  // Letter-spacing also trails the last letter, so pull that back with a negative margin.
  const letters = first.textContent.length;
  const spacing = letters > 1 ? Math.max(0, width - first.getBoundingClientRect().width) / (letters - 1) : 0;
  first.style.letterSpacing = `${spacing.toFixed(2)}px`;
  first.style.marginRight = `${(-spacing).toFixed(2)}px`;
}
function fitTitles() {
  fitBlockTitle(document.getElementById('toolbar-title'), 72);
  fitBlockTitle(document.getElementById('intro-title'), 200);
}

// ---------------- Filename search (collapsed behind an icon) ----------------

function setSearchOpen(open) {
  document.getElementById('search').classList.toggle('hidden', !open);
  document.getElementById('btn-search-toggle').classList.toggle('active', !!state.search);
}

function setSearch(text) {
  state.search = text;
  state.page = 0;
  document.getElementById('btn-search-toggle').classList.toggle('active', !!text);
  renderGrid();
}

function wireSearch() {
  const input = document.getElementById('search');
  document.getElementById('btn-search-toggle').addEventListener('click', () => {
    if (input.classList.contains('hidden')) {
      setSearchOpen(true);
      input.focus();
    } else {
      // Closing the box also clears the search, so no hidden filter is left behind.
      input.value = '';
      if (state.search) setSearch('');
      setSearchOpen(false);
    }
  });
  input.addEventListener('input', () => setSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // don't let the global Esc handler also clear the selection
    input.value = '';
    if (state.search) setSearch('');
    setSearchOpen(false);
    input.blur();
  });
  input.addEventListener('blur', (e) => {
    // Clicking the toggle handles closing itself; otherwise tuck an empty box away.
    if (e.relatedTarget?.id === 'btn-search-toggle') return;
    if (!input.value) setSearchOpen(false);
  });
}

function init() {
  loadPrefs();
  fitTitles();
  // Re-fit once the title font has actually loaded (widths change with the font).
  if (document.fonts) document.fonts.ready.then(fitTitles);

  if (!window.showDirectoryPicker) {
    document.getElementById('unsupported').classList.remove('hidden');
    return;
  }

  spinIntroLogoOnFirstVisit();

  document.getElementById('btn-open').addEventListener('click', openFolder);
  document.getElementById('btn-rescan').addEventListener('click', () => {
    if (state.dirHandle) loadFolder(state.dirHandle, { preserveView: true });
  });

  wireSearch();

  wireGridEvents();
  wireViewbar();
  wireSidebarResizer();

  document.getElementById('btn-clear-selection').addEventListener('click', clearSelection);

  const dropdown = document.getElementById('add-group-dropdown');
  document.getElementById('btn-add-group').addEventListener('click', (e) => {
    e.stopPropagation();
    renderAddGroupMenu();
    dropdown.classList.toggle('open');
    if (dropdown.classList.contains('open')) {
      positionDropdownMenu();
      document.getElementById('new-group-input').focus();
    }
  });
  window.addEventListener('resize', positionDropdownMenu);
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) closeDropdown();
  });
  document.getElementById('new-group-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('new-group-input');
    const key = createGroup(input.value);
    if (key) {
      addSelectionToGroup(key);
      renderAddGroupMenu();
      input.value = '';
      closeDropdown();
    }
  });

  document.getElementById('btn-remove-group').addEventListener('click', () => {
    if (state.activeFilter !== 'all' && state.activeFilter !== 'ungrouped') {
      removeSelectionFromGroup(state.activeFilter);
    }
  });

  document.getElementById('btn-stats').addEventListener('click', openStats);
  document.getElementById('stats-close').addEventListener('click', closeStats);
  document.getElementById('btn-export').addEventListener('click', exportCsv);
  document.getElementById('stats-backdrop').addEventListener('click', closeStats);

  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', () => lightboxStep(-1));
  document.getElementById('lightbox-next').addEventListener('click', () => lightboxStep(1));
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.getElementById('lightbox-groups').addEventListener('click', (e) => {
    const btn = e.target.closest('.lb-group');
    if (btn) togglePhotoGroup(state.lightboxPhoto, btn.dataset.key);
  });

  document.addEventListener('keydown', (e) => {
    const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    const digit = /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey ? Number(e.key) : 0;
    if (document.getElementById('lightbox').classList.contains('open')) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') lightboxStep(-1);
      else if (e.key === 'ArrowRight') lightboxStep(1);
      else if (digit) togglePhotoGroup(state.lightboxPhoto, hotkeyGroups()[digit - 1]);
      return;
    }
    if (document.getElementById('stats-modal').classList.contains('open')) {
      if (e.key === 'Escape') closeStats();
      return;
    }
    if (typing) return;
    if (e.key === 'Escape') clearSelection();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAllVisible();
    }
    else if (e.key === '[') stepPage(-1);
    else if (e.key === ']') stepPage(1);
    else if (digit) addSelectionToGroup(hotkeyGroups()[digit - 1]);
  });

  tryRestoreLastFolder();
}

init();
