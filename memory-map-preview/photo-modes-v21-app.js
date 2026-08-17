import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';
import {CLUSTER_ORDER, CLUSTERS} from './photo-modes-v13-data.js';
import {PHOTO_ATLAS_DATA_URL, PHOTO_ATLAS_RECTS} from './photo-atlas-v16-small.js';

const $ = (id) => document.getElementById(id);
const photoButton = $('photoBtn');
const nativeSetAttribute = photoButton.setAttribute.bind(photoButton);
const nativeRemoveAttribute = photoButton.removeAttribute.bind(photoButton);

// Never use native disabled for Photo: the iOS in-app browser retained that
// state across asynchronous POV transitions. aria-disabled controls appearance;
// the click handler enforces the actual World/Cluster/POV rule.
nativeRemoveAttribute('disabled');
Object.defineProperty(photoButton, 'disabled', {
  configurable: true,
  get() { return false; },
  set(value) {
    photoButton.dataset.requestedDisabled = String(Boolean(value));
    nativeRemoveAttribute('disabled');
  }
});
photoButton.setAttribute = function patchedSetAttribute(name, value) {
  if (name === 'disabled') {
    nativeRemoveAttribute('disabled');
    return;
  }
  if (name === 'aria-disabled') {
    photoButton.dataset.baseAriaDisabled = String(value);
    return;
  }
  return nativeSetAttribute(name, value);
};

let capturedMap = null;
const originalOn = maplibregl.Map.prototype.on;
maplibregl.Map.prototype.on = function captureMapOn(...args) {
  capturedMap = this;
  return originalOn.apply(this, args);
};

// Retains the gradual turn-during-lift transition and starts the established
// World → Cluster → POV application.
await import('./photo-modes-v15-turn-app.js');

const canvas = $('photoCanvas');
const context = canvas.getContext('2d');
const povButton = $('pov');
const poseChip = $('pose');
const note = $('note');
const clusterButtonIds = {flatiron: 'cluster-flatiron', noho: 'cluster-noho', central: 'cluster-central'};
const clusterMarkers = new Map();
let photoVisible = false;
let photoLoading = false;
let currentPhotoId = null;
let loadToken = 0;
let atlasImage = null;
let atlasFailed = null;
let syncQueued = false;

const atlasPromise = new Promise((resolve, reject) => {
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    atlasImage = image;
    resolve(image);
    drawAllMarkerMosaics();
    syncUi();
  };
  image.onerror = () => {
    atlasFailed = new Error('The compact trip-photo atlas could not be decoded.');
    reject(atlasFailed);
    syncUi();
  };
  image.src = PHOTO_ATLAS_DATA_URL;
});
atlasPromise.catch(() => {});

function inPov() {
  return povButton.classList.contains('active') || /^POV\b/.test(poseChip.textContent || '');
}

function currentSelection() {
  const clusterId = Object.entries(clusterButtonIds)
    .find(([, elementId]) => $(elementId)?.classList.contains('active'))?.[0];
  if (!clusterId || !CLUSTERS[clusterId]) return null;
  const dots = [...document.querySelectorAll('#dots .dot')];
  let index = dots.findIndex((dot) => dot.classList.contains('active'));
  if (index < 0) index = 0;
  return CLUSTERS[clusterId].observations[Math.min(index, CLUSTERS[clusterId].observations.length - 1)] || null;
}

function normalizedRect(id) {
  return PHOTO_ATLAS_RECTS[String(id)] || null;
}

function cropForCover(sourceWidth, sourceHeight, destinationWidth, destinationHeight) {
  const sourceAspect = sourceWidth / sourceHeight;
  const destinationAspect = destinationWidth / destinationHeight;
  if (sourceAspect > destinationAspect) {
    const width = sourceHeight * destinationAspect;
    return {x: (sourceWidth - width) / 2, y: 0, width, height: sourceHeight};
  }
  const height = sourceWidth / destinationAspect;
  return {x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height};
}

function drawAtlasCell(targetCanvas, id) {
  if (!atlasImage) return false;
  const rect = normalizedRect(id);
  if (!rect) return false;
  const [u, v, widthFraction, heightFraction] = rect;
  const sourceX = Math.round(u * atlasImage.naturalWidth);
  const sourceY = Math.round(v * atlasImage.naturalHeight);
  const sourceWidth = Math.max(1, Math.round(widthFraction * atlasImage.naturalWidth));
  const sourceHeight = Math.max(1, Math.round(heightFraction * atlasImage.naturalHeight));
  const ctx = targetCanvas.getContext('2d');
  if (!ctx) return false;
  if (!targetCanvas.width) targetCanvas.width = 160;
  if (!targetCanvas.height) targetCanvas.height = 120;
  const crop = cropForCover(sourceWidth, sourceHeight, targetCanvas.width, targetCanvas.height);
  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  ctx.drawImage(
    atlasImage,
    sourceX + crop.x,
    sourceY + crop.y,
    crop.width,
    crop.height,
    0,
    0,
    targetCanvas.width,
    targetCanvas.height
  );
  return true;
}

function sizePhotoCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function drawPhoto(id) {
  if (!atlasImage || !context) throw new Error('Photo atlas is not ready.');
  const rect = normalizedRect(id);
  if (!rect) throw new Error(`No atlas cell exists for observation ${id}.`);
  sizePhotoCanvas();
  const [u, v, widthFraction, heightFraction] = rect;
  const sourceX = Math.round(u * atlasImage.naturalWidth);
  const sourceY = Math.round(v * atlasImage.naturalHeight);
  const sourceWidth = Math.max(1, Math.round(widthFraction * atlasImage.naturalWidth));
  const sourceHeight = Math.max(1, Math.round(heightFraction * atlasImage.naturalHeight));
  const crop = cropForCover(sourceWidth, sourceHeight, canvas.width, canvas.height);
  context.fillStyle = '#05070a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    atlasImage,
    sourceX + crop.x,
    sourceY + crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
}

function hidePhoto(updateCopy = false) {
  ++loadToken;
  photoVisible = false;
  photoLoading = false;
  canvas.classList.remove('visible');
  document.body.classList.remove('photo-visible');
  photoButton.classList.remove('active', 'loading');
  if (updateCopy && inPov()) note.textContent = 'Reconstructed POV · Photo is the same-perspective evidence toggle.';
  window.setTimeout(() => {
    if (!photoVisible && context) context.clearRect(0, 0, canvas.width, canvas.height);
  }, 560);
  syncUi();
}

async function showPhoto() {
  if (!inPov()) {
    note.textContent = 'Enter POV first; Photo is the same-perspective evidence toggle.';
    return;
  }
  const observation = currentSelection();
  if (!observation) {
    note.textContent = 'No selected photograph is available.';
    return;
  }
  const token = ++loadToken;
  photoLoading = true;
  note.textContent = 'Preparing the photograph…';
  syncUi();
  try {
    await atlasPromise;
    if (token !== loadToken || !inPov()) return;
    const latest = currentSelection();
    if (!latest || String(latest.id) !== String(observation.id)) return;
    drawPhoto(observation.id);
    currentPhotoId = String(observation.id);
    photoVisible = true;
    photoLoading = false;
    canvas.classList.add('visible');
    document.body.classList.add('photo-visible');
    note.textContent = 'Actual photograph · tap Photo again to return to the reconstructed POV.';
  } catch (error) {
    photoLoading = false;
    photoVisible = false;
    note.textContent = `Photo failed to load: ${error.message}`;
  }
  syncUi();
}

function markerLayout(count) {
  if (count <= 1) return 'layout-1';
  if (count === 2) return 'layout-2';
  if (count === 3) return 'layout-3';
  return 'layout-plus';
}

function createClusterMarkers() {
  if (!capturedMap || clusterMarkers.size) return;
  for (const clusterId of CLUSTER_ORDER) {
    const cluster = CLUSTERS[clusterId];
    const root = document.createElement('div');
    root.className = 'clusterPhotoMarkerRoot';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `clusterPhotoCard ${markerLayout(cluster.observations.length)} hidden`;
    card.setAttribute('aria-label', `Open ${cluster.name}, ${cluster.observations.length} photo${cluster.observations.length === 1 ? '' : 's'}`);
    const mosaic = document.createElement('span');
    mosaic.className = 'mosaic';
    const visibleCount = cluster.observations.length <= 3 ? cluster.observations.length : Math.min(4, cluster.observations.length);
    for (const observation of cluster.observations.slice(0, visibleCount)) {
      const thumb = document.createElement('canvas');
      thumb.width = 160;
      thumb.height = 120;
      thumb.dataset.observationId = String(observation.id);
      mosaic.appendChild(thumb);
    }
    if (cluster.observations.length > 4) {
      const badge = document.createElement('span');
      badge.className = 'moreBadge';
      badge.textContent = `+${cluster.observations.length - 4}`;
      mosaic.appendChild(badge);
    }
    const label = document.createElement('span');
    label.className = 'markerLabel';
    label.innerHTML = `<b>${cluster.name}</b><small>${cluster.observations.length} photo${cluster.observations.length === 1 ? '' : 's'}</small>`;
    card.append(mosaic, label);
    root.appendChild(card);
    card.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      $(clusterButtonIds[clusterId])?.click();
    });
    const marker = new maplibregl.Marker({element: root, anchor: 'bottom', offset: [0, -6]})
      .setLngLat(cluster.center)
      .addTo(capturedMap);
    clusterMarkers.set(clusterId, {marker, card, root});
  }
  drawAllMarkerMosaics();
  syncClusterMarkers();
}

function drawAllMarkerMosaics() {
  if (!atlasImage) return;
  document.querySelectorAll('.clusterPhotoCard canvas[data-observation-id]').forEach((thumb) => {
    drawAtlasCell(thumb, thumb.dataset.observationId);
  });
}

function syncClusterMarkers() {
  const world = $('world')?.classList.contains('active');
  const pose = poseChip.textContent || '';
  const transit = /TRANSIT|AREA/.test(pose);
  const activeCluster = Object.entries(clusterButtonIds)
    .find(([, elementId]) => $(elementId)?.classList.contains('active'))?.[0] || null;
  for (const [clusterId, entry] of clusterMarkers) {
    entry.card.classList.remove('world', 'transit', 'hidden', 'active');
    if (world) entry.card.classList.add('world');
    else if (transit) entry.card.classList.add('transit');
    else entry.card.classList.add('hidden');
    entry.card.classList.toggle('active', Boolean(activeCluster && clusterId === activeCluster));
  }
}

function syncUi() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    const pov = inPov();
    nativeRemoveAttribute('disabled');
    nativeSetAttribute('aria-disabled', String(!pov));
    photoButton.classList.toggle('loading', pov && photoLoading);
    photoButton.classList.toggle('active', pov && photoVisible);
    if (!pov && (photoVisible || photoLoading)) hidePhoto(false);
    if (photoVisible) poseChip.textContent = 'POV · PHOTO';
    syncClusterMarkers();
  });
}

photoButton.onclick = null;
photoButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (photoVisible) hidePhoto(true);
  else showPhoto();
});

document.addEventListener('pointerdown', (event) => {
  const button = event.target.closest?.('button');
  if (button && button !== photoButton && (photoVisible || photoLoading)) hidePhoto(false);
}, true);

const observer = new MutationObserver(syncUi);
observer.observe(document.body, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class']
});

window.addEventListener('resize', () => {
  if (photoVisible && currentPhotoId) {
    try { drawPhoto(currentPhotoId); } catch {}
  }
}, {passive: true});

function ensureMarkers() {
  if (!capturedMap) return;
  if (capturedMap.isStyleLoaded?.()) createClusterMarkers();
  else originalOn.call(capturedMap, 'style.load', createClusterMarkers);
}

ensureMarkers();
setInterval(() => {
  ensureMarkers();
  syncUi();
}, 180);
syncUi();
