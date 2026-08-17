import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';
import {CLUSTER_ORDER, CLUSTERS} from './photo-modes-v13-data.js';

const $ = (id) => document.getElementById(id);
const photoButton = $('photoBtn');
const povButton = $('pov');
const poseChip = $('pose');
const note = $('note');
const canvas = $('photoCanvas');
const context = canvas.getContext('2d');
const ATLAS_URL = './assets-v20/atlas-v20-mobile.jpg?v=db443e29';
const OBSERVATION_ORDER = ['1300','1303','1304','1308','1311','1313','1314','1315','1317','1320','1322','1323'];
const CELL_BY_ID = Object.fromEntries(OBSERVATION_ORDER.map((id, index) => [id, {col:index % 4, row:Math.floor(index / 4)}]));
const CLUSTER_BUTTON_IDS = {flatiron:'cluster-flatiron', noho:'cluster-noho', central:'cluster-central'};

// The base v14 app uses the native disabled property. Safari's in-app browser
// retained that state after POV, so this page never uses native disabling.
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
let clusterMarkers = new Map();
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
  if (type === 'style.load' && !this.__memoryV20ExtensionHook) {
    this.__memoryV20ExtensionHook = true;
    originalOn.call(this, 'style.load', () => {
      capturedMap = this;
      setTimeout(() => initializeExtensions(this), 80);
    });
  }
  return originalOn.call(this, type, ...rest);
};

// Retains the gradual turn-during-lift behavior and boots the World/Cluster/POV app.
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
    scheduleSync();
  };
  image.onerror = () => {
    atlasLoading = false;
    atlasFailed = true;
    const error = new Error(`Photo atlas failed to load (${ATLAS_URL}).`);
    atlasReject(error);
    if (note) note.textContent = error.message;
    scheduleSync();
  };
  image.src = ATLAS_URL;
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

function sizeCanvas() {
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
  const cell = CELL_BY_ID[String(observation.id)];
  if (!cell) return false;
  sizeCanvas();
  const cellWidth = atlasImage.naturalWidth / 4;
  const cellHeight = atlasImage.naturalHeight / 3;
  const viewportAspect = canvas.width / canvas.height;
  const sourceAspect = cellWidth / cellHeight;
  let sx = cell.col * cellWidth;
  let sy = cell.row * cellHeight;
  let sw = cellWidth;
  let sh = cellHeight;
  if (sourceAspect > viewportAspect) {
    sw = cellHeight * viewportAspect;
    sx += (cellWidth - sw) / 2;
  } else {
    sh = cellWidth / viewportAspect;
    sy += (cellHeight - sh) / 2;
  }
  context.fillStyle = '#05070a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(atlasImage, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return true;
}

async function showPhoto() {
  const observation = currentObservation();
  if (!isPov() || !observation || !CELL_BY_ID[String(observation.id)]) {
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
    if (!drawObservation(observation)) throw new Error('The selected atlas cell could not be drawn.');
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

function backgroundPositionFor(id) {
  const cell = CELL_BY_ID[String(id)] || {col:0,row:0};
  return `${cell.col * 100 / 3}% ${cell.row * 100 / 2}%`;
}

function markerLayout(count) {
  if (count <= 1) return 'layout-1';
  if (count === 2) return 'layout-2';
  if (count === 3) return 'layout-3';
  return 'layout-plus';
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
  for (const observation of cluster.observations.slice(0, visibleCount)) {
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    thumb.style.backgroundPosition = backgroundPositionFor(observation.id);
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
  clusterMarkers.set(clusterId, {marker, button});
}

function initializeExtensions(map) {
  if (extensionsReady) return;
  extensionsReady = true;
  for (const clusterId of CLUSTER_ORDER) createClusterMarker(map, clusterId);
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
  const supported = Boolean(observation && CELL_BY_ID[String(observation.id)]);
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
