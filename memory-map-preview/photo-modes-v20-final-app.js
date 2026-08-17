import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';
import {CLUSTER_ORDER, CLUSTERS} from './photo-modes-v13-data.js';
import {PHOTO_ATLAS_DATA_URL, PHOTO_ATLAS_RECTS} from './photo-atlas-v16-small.js';

const $ = (id) => document.getElementById(id);
const photoButton = $('photoBtn');
const povButton = $('pov');
const poseChip = $('pose');
const note = $('note');
const canvas = $('photoCanvas');
const context = canvas.getContext('2d');
const CLUSTER_BUTTON_IDS = {flatiron:'cluster-flatiron', noho:'cluster-noho', central:'cluster-central'};

// The host WebView retained native disabled state in earlier builds. This page
// deliberately represents availability with aria-disabled and CSS only.
const nativeRemoveAttribute = photoButton.removeAttribute.bind(photoButton);
nativeRemoveAttribute('disabled');
Object.defineProperty(photoButton, 'disabled', {
  configurable: true,
  enumerable: true,
  get() { return false; },
  set(value) {
    photoButton.dataset.requestedDisabled = String(Boolean(value));
    nativeRemoveAttribute('disabled');
  }
});

let capturedMap = null;
let extensionsReady = false;
const clusterMarkers = new Map();
let atlasImage = null;
let atlasFailed = false;
let atlasLoading = false;
let atlasResolve;
let atlasReject;
const atlasPromise = new Promise((resolve, reject) => { atlasResolve = resolve; atlasReject = reject; });
let photoShown = false;
let photoLoading = false;
let selectedObservationId = null;
let syncQueued = false;
let hideTimer = 0;

const originalOn = maplibregl.Map.prototype.on;
maplibregl.Map.prototype.on = function patchedOn(type, ...rest) {
  capturedMap = capturedMap || this;
  if (type === 'style.load' && !this.__memoryV20FinalHook) {
    this.__memoryV20FinalHook = true;
    originalOn.call(this, 'style.load', () => {
      capturedMap = this;
      setTimeout(() => initializeExtensions(this), 100);
    });
  }
  return originalOn.call(this, type, ...rest);
};

// Preserve the gradual turn-during-lift camera choreography and boot the base app.
await import('./photo-modes-v15-turn-app.js');
photoButton.onclick = null;

function loadAtlas() {
  if (atlasImage || atlasLoading || atlasFailed) return atlasPromise;
  atlasLoading = true;
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    atlasLoading = false;
    atlasImage = image;
    atlasResolve(image);
    redrawMarkerThumbnails();
    scheduleSync();
  };
  image.onerror = () => {
    atlasLoading = false;
    atlasFailed = true;
    const error = new Error('The compact photo atlas could not be decoded.');
    atlasReject(error);
    note.textContent = error.message;
    scheduleSync();
  };
  image.src = PHOTO_ATLAS_DATA_URL;
  return atlasPromise;
}
loadAtlas();

function currentClusterId() {
  return Object.entries(CLUSTER_BUTTON_IDS)
    .find(([, elementId]) => $(elementId)?.classList.contains('active'))?.[0] || null;
}

function currentObservation() {
  const clusterId = currentClusterId();
  if (!clusterId || !CLUSTERS[clusterId]) return null;
  const dots = [...document.querySelectorAll('#dots .dot')];
  let index = dots.findIndex((dot) => dot.classList.contains('active'));
  if (index < 0) index = 0;
  return CLUSTERS[clusterId].observations[Math.min(index, CLUSTERS[clusterId].observations.length - 1)] || null;
}

function isPov() {
  return povButton.classList.contains('active') || /^POV\b/.test(poseChip.textContent || '');
}

function normalizedRect(id) {
  return PHOTO_ATLAS_RECTS[String(id)] || null;
}

function drawRectCover(targetCanvas, image, rect) {
  const targetContext = targetCanvas.getContext('2d');
  if (!targetContext || !image || !rect) return false;
  const [nx, ny, nw, nh] = rect;
  const sourceX = nx * image.naturalWidth;
  const sourceY = ny * image.naturalHeight;
  const sourceWidth = nw * image.naturalWidth;
  const sourceHeight = nh * image.naturalHeight;
  const viewportAspect = targetCanvas.width / targetCanvas.height;
  const sourceAspect = sourceWidth / sourceHeight;
  let sx = sourceX;
  let sy = sourceY;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceAspect > viewportAspect) {
    sw = sourceHeight * viewportAspect;
    sx += (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / viewportAspect;
    sy += (sourceHeight - sh) / 2;
  }
  targetContext.fillStyle = '#111b24';
  targetContext.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  targetContext.drawImage(image, sx, sy, sw, sh, 0, 0, targetCanvas.width, targetCanvas.height);
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

function drawObservation(observation) {
  if (!context || !atlasImage || !observation) return false;
  const rect = normalizedRect(observation.id);
  if (!rect) return false;
  sizePhotoCanvas();
  return drawRectCover(canvas, atlasImage, rect);
}

async function showPhoto() {
  const observation = currentObservation();
  if (!isPov() || !observation || !normalizedRect(observation.id)) {
    note.textContent = 'Enter POV first; Photo is the same-perspective evidence toggle.';
    return;
  }
  photoLoading = true;
  scheduleSync();
  note.textContent = 'Loading the photograph…';
  try {
    await loadAtlas();
    const latest = currentObservation();
    if (!isPov() || !latest || String(latest.id) !== String(observation.id)) return;
    if (!drawObservation(observation)) throw new Error('The selected photograph could not be drawn.');
    clearTimeout(hideTimer);
    selectedObservationId = String(observation.id);
    photoShown = true;
    photoLoading = false;
    document.body.classList.add('photo-visible');
    canvas.classList.add('visible');
    poseChip.textContent = 'POV · PHOTO';
    note.textContent = 'Actual photograph · tap Photo again to return to the reconstructed POV.';
  } catch (error) {
    photoLoading = false;
    photoShown = false;
    canvas.classList.remove('visible');
    document.body.classList.remove('photo-visible');
    note.textContent = `Photo failed: ${error.message}`;
  }
  scheduleSync();
}

function hidePhoto(updateCopy = true) {
  if (!photoShown && !photoLoading) return;
  photoShown = false;
  photoLoading = false;
  canvas.classList.remove('visible');
  document.body.classList.remove('photo-visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!photoShown && context) context.clearRect(0, 0, canvas.width, canvas.height);
  }, 540);
  if (isPov()) poseChip.textContent = 'POV';
  if (updateCopy && isPov()) note.textContent = 'Reconstructed POV · Photo is the same-perspective evidence toggle.';
  scheduleSync();
}

async function togglePhoto() {
  if (!isPov()) {
    note.textContent = 'Enter POV first; Photo is the same-perspective evidence toggle.';
    return;
  }
  if (photoShown) hidePhoto();
  else await showPhoto();
}

function markerLayout(count) {
  if (count <= 1) return 'layout-1';
  if (count === 2) return 'layout-2';
  if (count === 3) return 'layout-3';
  return 'layout-plus';
}

function drawMarkerThumb(thumbCanvas, observationId) {
  thumbCanvas.width = 120;
  thumbCanvas.height = 90;
  if (atlasImage) drawRectCover(thumbCanvas, atlasImage, normalizedRect(observationId));
}

function createClusterMarker(map, clusterId) {
  const cluster = CLUSTERS[clusterId];
  const root = document.createElement('div');
  root.className = 'memoryClusterMarker';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hidden';
  button.setAttribute('aria-label', `Open ${cluster.name}, ${cluster.observations.length} photo${cluster.observations.length === 1 ? '' : 's'}`);
  const mosaic = document.createElement('span');
  mosaic.className = `mosaic ${markerLayout(cluster.observations.length)}`;
  const visibleCount = cluster.observations.length <= 3 ? cluster.observations.length : Math.min(4, cluster.observations.length);
  const thumbs = [];
  for (const observation of cluster.observations.slice(0, visibleCount)) {
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    thumb.dataset.observationId = String(observation.id);
    drawMarkerThumb(thumb, observation.id);
    thumbs.push(thumb);
    mosaic.appendChild(thumb);
  }
  if (cluster.observations.length > 4) {
    const badge = document.createElement('span');
    badge.className = 'moreBadge';
    badge.textContent = `+${cluster.observations.length - 4}`;
    mosaic.appendChild(badge);
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.innerHTML = `<b>${cluster.name}</b><small>${cluster.observations.length} photo${cluster.observations.length === 1 ? '' : 's'}</small>`;
  button.append(mosaic, label);
  root.appendChild(button);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    $(CLUSTER_BUTTON_IDS[clusterId])?.click();
  });
  const marker = new maplibregl.Marker({element: root, anchor: 'bottom', offset: [0, -6]})
    .setLngLat(cluster.center)
    .addTo(map);
  clusterMarkers.set(clusterId, {marker, button, thumbs});
}

function redrawMarkerThumbnails() {
  if (!atlasImage) return;
  for (const entry of clusterMarkers.values()) {
    for (const thumb of entry.thumbs) drawMarkerThumb(thumb, thumb.dataset.observationId);
  }
}

function initializeExtensions(map) {
  if (extensionsReady) return;
  extensionsReady = true;
  for (const clusterId of CLUSTER_ORDER) createClusterMarker(map, clusterId);
  redrawMarkerThumbnails();
  map.on('movestart', () => {
    if (photoShown || photoLoading) hidePhoto(false);
  });
  map.on('moveend', scheduleSync);
  syncMarkerState();
  scheduleSync();
}

function syncMarkerState() {
  const pose = poseChip.textContent || '';
  const world = $('world')?.classList.contains('active') || pose === 'WORLD';
  const transit = /^TRANSIT$|^AREA\b/.test(pose);
  const activeCluster = currentClusterId();
  for (const [clusterId, entry] of clusterMarkers) {
    entry.button.classList.remove('world', 'transit', 'hidden', 'active');
    if (world) entry.button.classList.add('world');
    else if (transit) entry.button.classList.add('transit');
    else entry.button.classList.add('hidden');
    entry.button.classList.toggle('active', Boolean(activeCluster && clusterId === activeCluster));
  }
}

function syncUi() {
  syncQueued = false;
  const observation = currentObservation();
  const supported = Boolean(observation && normalizedRect(observation.id));
  const allowed = Boolean(isPov() && supported);
  photoButton.setAttribute('aria-disabled', String(!allowed));
  photoButton.classList.toggle('loading', allowed && (photoLoading || !atlasImage) && !atlasFailed);
  photoButton.classList.toggle('active', allowed && photoShown);
  if (!isPov() && (photoShown || photoLoading)) hidePhoto(false);
  if (photoShown && observation && String(observation.id) !== selectedObservationId) hidePhoto(false);
  syncMarkerState();
}

function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(syncUi);
}

photoButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  togglePhoto();
});

document.addEventListener('pointerdown', (event) => {
  const button = event.target.closest?.('button');
  if (button && button !== photoButton && (photoShown || photoLoading)) hidePhoto(false);
}, true);

const observer = new MutationObserver(scheduleSync);
observer.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['class']});
window.addEventListener('resize', () => {
  if (photoShown) {
    const observation = currentObservation();
    if (observation) drawObservation(observation);
  }
}, {passive:true});
setInterval(scheduleSync, 180);
scheduleSync();
