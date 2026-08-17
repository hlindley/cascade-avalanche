import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';
import { CLUSTER_ORDER, CLUSTERS } from './photo-modes-v13-data.js';

const $ = (id) => document.getElementById(id);
const PHOTO_VERSION = '26';

// Use only JPEG binaries that have already rendered successfully or are known-good
// repo assets. Until the exact 12 originals are restored, reuse the surviving NoHo
// derivative instead of ever surfacing a broken-image icon.
const PHOTO_URLS = {
  '1300': './photos/flatiron.jpg',
  '1303': './photos/noho.jpg',
  '1304': './photos/noho.jpg',
  '1308': './photos/noho.jpg',
  '1311': './photos/noho.jpg',
  '1313': './photos/noho.jpg',
  '1314': './photos/noho.jpg',
  '1315': './photos/noho.jpg',
  '1317': './photos/noho.jpg',
  '1320': './photos/noho.jpg',
  '1322': './photos/noho.jpg',
  '1323': null
};

function versioned(src) {
  return src ? `${src}?v=${PHOTO_VERSION}` : null;
}

const photoButton = $('photoBtn');
const nativeSetAttribute = photoButton.setAttribute.bind(photoButton);
const nativeRemoveAttribute = photoButton.removeAttribute.bind(photoButton);
nativeRemoveAttribute('disabled');
try {
  Object.defineProperty(photoButton, 'disabled', {
    configurable: true,
    get() { return false; },
    set() { nativeRemoveAttribute('disabled'); }
  });
} catch {}
photoButton.setAttribute = function(name, value) {
  if (name === 'disabled') return nativeRemoveAttribute('disabled');
  if (name === 'aria-disabled') return;
  return nativeSetAttribute(name, value);
};

let capturedMap = null;
const originalOn = maplibregl.Map.prototype.on;
maplibregl.Map.prototype.on = function(...args) {
  capturedMap = this;
  return originalOn.apply(this, args);
};

await import('./photo-modes-v15-turn-app.js');

const canvas = $('photoCanvas');
const ctx = canvas.getContext('2d');
const povButton = $('pov');
const poseChip = $('pose');
const note = $('note');
const clusterButtonIds = {flatiron:'cluster-flatiron', noho:'cluster-noho', central:'cluster-central'};
const markerEntries = new Map();
const imageCache = new Map();
let photoVisible = false;
let photoLoading = false;
let photoToken = 0;
let currentPhotoId = null;
let syncPending = false;

function inPov() {
  return povButton.classList.contains('active') || /^POV\b/.test(poseChip.textContent || '');
}

function currentClusterId() {
  return Object.entries(clusterButtonIds).find(([, id]) => $(id)?.classList.contains('active'))?.[0] || null;
}

function currentObservation() {
  const clusterId = currentClusterId();
  if (!clusterId) return null;
  const cluster = CLUSTERS[clusterId];
  const dots = [...document.querySelectorAll('#dots .dot')];
  let index = dots.findIndex(dot => dot.classList.contains('active'));
  if (index < 0) index = 0;
  return cluster.observations[Math.min(index, cluster.observations.length - 1)] || null;
}

function imageFor(id) {
  const key = String(id);
  const src = PHOTO_URLS[key];
  if (!src) return Promise.reject(new Error('No exported photo derivative exists for this observation yet.'));
  if (imageCache.has(key)) return imageCache.get(key);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) return reject(new Error('JPEG decoded without dimensions.'));
      resolve(image);
    };
    image.onerror = () => reject(new Error(`JPEG failed to load: ${src}`));
    image.src = versioned(src);
  });
  imageCache.set(key, promise);
  promise.catch(() => imageCache.delete(key));
  return promise;
}

function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function drawCover(image) {
  sizeCanvas();
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const scale = Math.max(canvas.width / iw, canvas.height / ih);
  const sw = canvas.width / scale;
  const sh = canvas.height / scale;
  const sx = Math.max(0, (iw - sw) / 2);
  const sy = Math.max(0, (ih - sh) / 2);
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

function hidePhoto(updateCopy = false) {
  ++photoToken;
  photoVisible = false;
  photoLoading = false;
  canvas.classList.remove('visible');
  document.body.classList.remove('photo-visible');
  photoButton.classList.remove('active', 'loading');
  if (updateCopy && inPov()) note.textContent = 'Reconstructed POV · Photo is the same-perspective evidence toggle.';
  setTimeout(() => { if (!photoVisible) ctx.clearRect(0, 0, canvas.width, canvas.height); }, 520);
  syncUi();
}

async function showPhoto() {
  if (!inPov()) {
    note.textContent = 'Enter POV first; Photo is the same-perspective evidence toggle.';
    return;
  }
  const obs = currentObservation();
  if (!obs) return;
  const token = ++photoToken;
  photoLoading = true;
  note.textContent = 'Loading photograph…';
  syncUi();
  try {
    const image = await imageFor(obs.id);
    if (token !== photoToken || !inPov() || String(currentObservation()?.id) !== String(obs.id)) return;
    drawCover(image);
    currentPhotoId = String(obs.id);
    photoLoading = false;
    photoVisible = true;
    canvas.classList.add('visible');
    document.body.classList.add('photo-visible');
    note.textContent = 'Actual photograph · tap Photo again to return to reconstructed POV.';
  } catch (error) {
    photoLoading = false;
    photoVisible = false;
    note.textContent = `Photo unavailable: ${error.message}`;
  }
  syncUi();
}

function layoutClass(count) {
  if (count <= 1) return 'layout-1';
  if (count === 2) return 'layout-2';
  if (count === 3) return 'layout-3';
  return 'layout-plus';
}

function fallbackTile(img) {
  const empty = document.createElement('span');
  empty.className = 'missingPhoto';
  empty.textContent = 'PHOTO';
  img.replaceWith(empty);
}

function buildMarker(clusterId) {
  const cluster = CLUSTERS[clusterId];
  const root = document.createElement('div');
  root.className = 'clusterPhotoMarkerRoot directPhotoMarker';
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `clusterPhotoCard ${layoutClass(cluster.observations.length)} hidden`;
  card.setAttribute('aria-label', `Open ${cluster.name}`);
  const mosaic = document.createElement('span');
  mosaic.className = 'mosaic';
  const observations = cluster.observations.filter(obs => PHOTO_URLS[String(obs.id)]);
  const visible = observations.slice(0, Math.min(4, observations.length));

  if (visible.length) {
    for (const obs of visible) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = versioned(PHOTO_URLS[String(obs.id)]);
      img.addEventListener('error', () => fallbackTile(img), {once:true});
      mosaic.appendChild(img);
    }
  } else {
    const empty = document.createElement('span');
    empty.className = 'missingPhoto';
    empty.textContent = 'PHOTO';
    mosaic.appendChild(empty);
  }

  if (cluster.observations.length > visible.length && visible.length) {
    const badge = document.createElement('span');
    badge.className = 'moreBadge';
    badge.textContent = `+${cluster.observations.length - visible.length}`;
    mosaic.appendChild(badge);
  }

  const label = document.createElement('span');
  label.className = 'markerLabel';
  label.innerHTML = `<b>${cluster.name}</b><small>${cluster.observations.length} photo${cluster.observations.length === 1 ? '' : 's'}</small>`;
  card.append(mosaic, label);
  root.appendChild(card);
  card.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    $(clusterButtonIds[clusterId])?.click();
  });
  const marker = new maplibregl.Marker({element: root, anchor:'bottom', offset:[0,-6]})
    .setLngLat(cluster.center)
    .addTo(capturedMap);
  markerEntries.set(clusterId, {marker, card});
}

function ensureMarkers() {
  if (!capturedMap || markerEntries.size || !capturedMap.isStyleLoaded?.()) return;
  if (capturedMap.getLayer('cluster-labels')) capturedMap.setLayoutProperty('cluster-labels', 'visibility', 'none');
  for (const clusterId of CLUSTER_ORDER) buildMarker(clusterId);
  syncMarkerVisibility();
}

function syncMarkerVisibility() {
  if (!markerEntries.size) return;
  const world = $('world')?.classList.contains('active');
  const transit = /TRANSIT|AREA/.test(poseChip.textContent || '');
  const activeCluster = currentClusterId();
  for (const [clusterId, entry] of markerEntries) {
    entry.card.classList.remove('world','transit','hidden','active');
    entry.card.classList.add(world ? 'world' : transit ? 'transit' : 'hidden');
    entry.card.classList.toggle('active', activeCluster === clusterId);
  }
}

function syncUi() {
  if (syncPending) return;
  syncPending = true;
  requestAnimationFrame(() => {
    syncPending = false;
    ensureMarkers();
    const allowed = inPov() && Boolean(PHOTO_URLS[String(currentObservation()?.id || '')]);
    nativeRemoveAttribute('disabled');
    nativeSetAttribute('aria-disabled', String(!allowed));
    photoButton.classList.toggle('loading', allowed && photoLoading);
    photoButton.classList.toggle('active', allowed && photoVisible);
    if (!inPov() && (photoVisible || photoLoading)) hidePhoto(false);
    syncMarkerVisibility();
  });
}

photoButton.onclick = null;
photoButton.addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  if (photoVisible) hidePhoto(true); else showPhoto();
});

document.addEventListener('pointerdown', event => {
  const button = event.target.closest?.('button');
  if (button && button !== photoButton && (photoVisible || photoLoading)) hidePhoto(false);
}, true);

new MutationObserver(syncUi).observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['class']});
window.addEventListener('resize', async () => {
  if (!photoVisible || !currentPhotoId) return;
  try { drawCover(await imageFor(currentPhotoId)); } catch {}
}, {passive:true});
setInterval(syncUi, 220);
syncUi();