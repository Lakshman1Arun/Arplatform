// ---------------------------------------------------------------------------
// Config — the limits. Tune these.
// ---------------------------------------------------------------------------
const LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,   // 50 MB per model
  maxModels: 12,                     // max models stored in this browser
  allowedExtensions: ['glb', 'gltf', 'usdz'],
};

const DB_NAME = 'fieldscope';
const DB_VERSION = 1;
const STORE = 'models';

// ---------------------------------------------------------------------------
// IndexedDB helpers (models persist in this browser only — no server)
// ---------------------------------------------------------------------------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const uploadStatus = document.getElementById('uploadStatus');
const gallery = document.getElementById('gallery');
const emptyState = document.getElementById('emptyState');
const galleryCount = document.getElementById('galleryCount');
const quota = document.getElementById('quota');
const dzLimits = document.getElementById('dzLimits');

const viewerOverlay = document.getElementById('viewerOverlay');
const viewerClose = document.getElementById('viewerClose');
const viewerName = document.getElementById('viewerName');
const modelViewer = document.getElementById('modelViewer');
const toast = document.getElementById('toast');

dzLimits.textContent = `up to ${formatBytes(LIMITS.maxFileBytes)} · ${LIMITS.allowedExtensions.join(', ')} · max ${LIMITS.maxModels} models`;

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(filename) {
  return filename.split('.').pop().toLowerCase();
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function setStatus(msg, kind) {
  uploadStatus.textContent = msg;
  uploadStatus.className = 'upload-status' + (kind ? ` ${kind}` : '');
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// Validation — this is where the limits are enforced
// ---------------------------------------------------------------------------
async function validateFile(file, existingCount) {
  const ext = extOf(file.name);

  if (!LIMITS.allowedExtensions.includes(ext)) {
    return `"${file.name}" isn't a supported format. Use ${LIMITS.allowedExtensions.join(', ')}.`;
  }

  if (file.size === 0) {
    return `"${file.name}" is empty.`;
  }

  if (file.size > LIMITS.maxFileBytes) {
    return `"${file.name}" is ${formatBytes(file.size)}, over the ${formatBytes(LIMITS.maxFileBytes)} limit.`;
  }

  if (existingCount >= LIMITS.maxModels) {
    return `You've hit the ${LIMITS.maxModels}-model limit for this browser. Delete one to add another.`;
  }

  // .gltf files that reference external .bin/texture files won't render on
  // their own — only self-contained (embedded/base64) glTF works here.
  if (ext === 'gltf') {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const external = (json.buffers || []).some(b => b.uri && !b.uri.startsWith('data:'));
      if (external) {
        return `"${file.name}" references external files (.bin/textures). Export as .glb instead — it packs everything into one file.`;
      }
    } catch {
      return `"${file.name}" doesn't look like valid glTF JSON.`;
    }
  }

  return null; // valid
}

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return;

  const existing = await dbGetAll();
  let count = existing.length;

  for (const file of files) {
    const error = await validateFile(file, count);
    if (error) {
      setStatus(error, 'error');
      continue;
    }

    setStatus(`Storing "${file.name}"…`);
    const record = {
      id: uid(),
      name: file.name,
      ext: extOf(file.name),
      size: file.size,
      blob: file,
      createdAt: Date.now(),
    };
    await dbPut(record);
    count += 1;
    setStatus(`"${file.name}" added.`, 'ok');
  }

  await renderGallery();
}

fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
  })
);
dropzone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

// ---------------------------------------------------------------------------
// Gallery rendering
// ---------------------------------------------------------------------------
async function renderGallery() {
  const models = await dbGetAll();

  quota.textContent = `${models.length} / ${LIMITS.maxModels} slots used`;
  galleryCount.textContent = `${models.length} stored`;
  emptyState.style.display = models.length ? 'none' : 'block';

  gallery.querySelectorAll('.card').forEach(el => el.remove());

  for (const model of models) {
    const url = URL.createObjectURL(model.blob);
    const card = document.createElement('div');
    card.className = 'card';

    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';

    if (model.ext === 'usdz') {
      thumb.innerHTML = `<span style="font-family: var(--font-mono); font-size: 11px;">AR-only · iOS</span>`;
    } else {
      const mv = document.createElement('model-viewer');
      mv.setAttribute('src', url);
      mv.setAttribute('camera-controls', '');
      mv.setAttribute('disable-zoom', '');
      mv.setAttribute('auto-rotate', '');
      mv.setAttribute('shadow-intensity', '0.6');
      thumb.appendChild(mv);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <p class="card-name" title="${model.name}">${model.name}</p>
      <div class="card-meta">
        <span>${formatBytes(model.size)}</span>
        <button class="card-delete" aria-label="Delete ${model.name}">delete</button>
      </div>
    `;

    body.querySelector('.card-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await dbDelete(model.id);
      URL.revokeObjectURL(url);
      showToast(`Deleted "${model.name}"`);
      renderGallery();
    });

    card.appendChild(thumb);
    card.appendChild(body);

    card.addEventListener('click', () => openViewer(model, url));

    gallery.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// AR Viewer
// ---------------------------------------------------------------------------
function openViewer(model, url) {
  if (model.ext === 'usdz') {
    // iOS Quick Look opens directly from a rel="ar" link — no 3D canvas needed.
    const a = document.createElement('a');
    a.rel = 'ar';
    a.href = url;
    a.appendChild(document.createElement('img'));
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Quick Look only opens on iOS Safari.');
    return;
  }

  viewerName.textContent = model.name;
  modelViewer.setAttribute('src', url);
  modelViewer.removeAttribute('ios-src');
  viewerOverlay.classList.add('open');
  viewerOverlay.setAttribute('aria-hidden', 'false');
}

function closeViewer() {
  viewerOverlay.classList.remove('open');
  viewerOverlay.setAttribute('aria-hidden', 'true');
  modelViewer.removeAttribute('src');
}

viewerClose.addEventListener('click', closeViewer);
viewerOverlay.addEventListener('click', (e) => {
  if (e.target === viewerOverlay) closeViewer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewerOverlay.classList.contains('open')) closeViewer();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
renderGallery();
