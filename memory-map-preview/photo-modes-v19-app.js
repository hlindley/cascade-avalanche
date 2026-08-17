import {CLUSTERS} from './photo-modes-v13-data.js';
import {PHOTO_ATLAS_DATA_URL, PHOTO_ATLAS_RECTS} from './photo-atlas-v16-small.js';

const photoButton = document.getElementById('photoBtn');
const nativeSetAttribute = photoButton.setAttribute.bind(photoButton);
const nativeRemoveAttribute = photoButton.removeAttribute.bind(photoButton);

// Do not use the native disabled state. The iOS in-app browser was retaining it
// after POV settled. Availability is represented through aria-disabled + CSS,
// while the click handler verifies the current mode.
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
photoButton.setAttribute = function patchedSetAttribute(name, value) {
  if (name === 'disabled') {
    photoButton.dataset.requestedDisabled = 'true';
    nativeRemoveAttribute('disabled');
    return;
  }
  if (name === 'aria-disabled') {
    photoButton.dataset.requestedAriaDisabled = String(value);
    return;
  }
  return nativeSetAttribute(name, value);
};

// Includes the gradual turn-during-lift choreography, then starts the v14 app.
await import('./photo-modes-v15-turn-app.js');

const canvas = document.getElementById('photoCanvas');
const context = canvas.getContext('2d', {alpha: false, desynchronized: true});
const povButton = document.getElementById('pov');
const poseChip = document.getElementById('pose');
const note = document.getElementById('note');
const clusterButtonIds = {flatiron:'cluster-flatiron', noho:'cluster-noho', central:'cluster-central'};
let atlas = null;
let atlasReady = false;
let atlasFailed = false;
let photoShown = false;
let selectedObservationId = null;
let syncQueued = false;
let hideTimer = 0;
let loadResolve;
const atlasPromise = new Promise((resolve) => { loadResolve = resolve; });

function inPov() {
  return povButton.classList.contains('active') || /^POV\b/.test(poseChip.textContent || '');
}

function currentSelection() {
  const clusterId = Object.entries(clusterButtonIds)
    .find(([, elementId]) => document.getElementById(elementId)?.classList.contains('active'))?.[0];
  if (!clusterId || !CLUSTERS[clusterId]) return null;
  const dots = [...document.querySelectorAll('#dots .dot')];
  let index = dots.findIndex((dot) => dot.classList.contains('active'));
  if (index < 0) index = 0;
  return CLUSTERS[clusterId].observations[Math.min(index, CLUSTERS[clusterId].observations.length - 1)] || null;
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
  if (!context || !atlasReady || !atlas || !observation) return false;
  const rect = PHOTO_ATLAS_RECTS[String(observation.id)];
  if (!rect) return false;
  sizeCanvas();

  const [nx, ny, nw, nh] = rect;
  let sx = nx * atlas.naturalWidth;
  let sy = ny * atlas.naturalHeight;
  let sw = nw * atlas.naturalWidth;
  let sh = nh * atlas.naturalHeight;
  const destinationAspect = canvas.width / canvas.height;
  const sourceAspect = sw / sh;

  // Equivalent to object-fit: cover, but the source is one atlas cell.
  if (sourceAspect > destinationAspect) {
    const croppedWidth = sh * destinationAspect;
    sx += (sw - croppedWidth) * 0.5;
    sw = croppedWidth;
  } else {
    const croppedHeight = sw / destinationAspect;
    sy += (sh - croppedHeight) * 0.5;
    sh = croppedHeight;
  }

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#05070a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(atlas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  context.restore();
  selectedObservationId = String(observation.id);
  return true;
}

function syncPhotoUi() {
  syncQueued = false;
  const observation = currentSelection();
  const supported = Boolean(observation && PHOTO_ATLAS_RECTS[String(observation.id)]);
  const available = Boolean(inPov() && supported && !atlasFailed);

  nativeRemoveAttribute('disabled');
  nativeSetAttribute('aria-disabled', String(!available));
  photoButton.classList.toggle('photo-loading', available && !atlasReady);
  photoButton.classList.toggle('photo-ready', available && atlasReady);
  photoButton.classList.toggle('active', available && photoShown);

  if (!inPov() && photoShown) hidePhoto(120, false);
  if (photoShown && observation && String(observation.id) !== selectedObservationId) {
    if (drawObservation(observation)) selectedObservationId = String(observation.id);
  }
}

function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(syncPhotoUi);
}

async function showPhoto() {
  const observation = currentSelection();
  if (!inPov() || !observation || !PHOTO_ATLAS_RECTS[String(observation.id)]) {
    note.textContent = 'Enter POV first; Photo is the same-perspective evidence toggle.';
    return;
  }
  if (!atlasReady) {
    note.textContent = 'Preparing the photograph…';
    const ready = await Promise.race([
      atlasPromise,
      new Promise((resolve) => setTimeout(() => resolve(false), 5000))
    ]);
    if (!ready || !inPov()) {
      note.textContent = atlasFailed ? 'Photo image could not be decoded; the map remains active.' : 'Photo is still loading. Tap again to retry.';
      scheduleSync();
      return;
    }
  }
  const latest = currentSelection();
  if (!latest || !drawObservation(latest)) {
    note.textContent = 'No photograph is wired to this observation yet.';
    return;
  }
  clearTimeout(hideTimer);
  photoShown = true;
  document.body.classList.add('photo-visible');
  canvas.style.visibility = 'visible';
  requestAnimationFrame(() => canvas.classList.add('visible'));
  poseChip.textContent = 'POV · PHOTO';
  note.textContent = 'Actual photograph · tap Photo again to return to reconstructed POV.';
  scheduleSync();
}

function hidePhoto(duration = 420, updateCopy = true) {
  if (!photoShown && !canvas.classList.contains('visible')) return;
  photoShown = false;
  document.body.classList.remove('photo-visible');
  canvas.classList.remove('visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!photoShown) {
      canvas.style.visibility = 'hidden';
      context?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, duration + 40);
  if (inPov()) poseChip.textContent = 'POV';
  if (updateCopy) note.textContent = 'Reconstructed POV · Photo is the same-perspective evidence toggle.';
  scheduleSync();
}

// Load one compact atlas once. The visible image is never an HTML img; the img
// exists only as an offscreen decoder source for CanvasRenderingContext2D.
atlas = new Image();
atlas.decoding = 'async';
atlas.onload = () => {
  atlasReady = true;
  atlasFailed = false;
  loadResolve(true);
  if (inPov()) note.textContent = 'Photo ready · tap Photo to compare.';
  scheduleSync();
};
atlas.onerror = () => {
  atlasFailed = true;
  atlasReady = false;
  loadResolve(false);
  note.textContent = 'Photo atlas failed to decode; the map remains active.';
  scheduleSync();
};
atlas.src = PHOTO_ATLAS_DATA_URL;

photoButton.onclick = null;
photoButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!inPov()) {
    note.textContent = 'Enter POV first; Photo is the same-perspective evidence toggle.';
    return;
  }
  if (photoShown) hidePhoto();
  else showPhoto();
});

// Hide before any navigation button changes the map. The canvas cannot receive
// pointer events, so this is independent of its visibility and opacity.
document.addEventListener('pointerdown', (event) => {
  const button = event.target.closest?.('button');
  if (button && button !== photoButton && photoShown) hidePhoto(120, false);
}, true);

const stateObserver = new MutationObserver(scheduleSync);
stateObserver.observe(document.body, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class']
});
window.addEventListener('resize', () => {
  if (photoShown) {
    const observation = currentSelection();
    requestAnimationFrame(() => drawObservation(observation));
  }
});
setInterval(syncPhotoUi, 220);
syncPhotoUi();
