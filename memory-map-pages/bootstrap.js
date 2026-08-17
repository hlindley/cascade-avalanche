import {ALL_OBS} from './data.js';
import {PHOTO_ATLAS_DATA_URL, PHOTO_ATLAS_RECTS} from './photo-atlas.js';

const status = document.getElementById('status');
const info = document.getElementById('info');
const blobUrls = [];

function dataUrlToBlobUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Photo atlas data is malformed.');
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mime = /^data:([^;]+)/.exec(header)?.[1] || 'image/jpeg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], {type: mime}));
  blobUrls.push(url);
  return url;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The trip photo atlas could not be decoded.'));
    image.src = url;
  });
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas JPEG encoding returned no data.')), 'image/jpeg', 0.9);
  });
}

async function makePhotoUrls() {
  const atlasUrl = dataUrlToBlobUrl(PHOTO_ATLAS_DATA_URL);
  const atlas = await loadImage(atlasUrl);

  for (const obs of ALL_OBS) {
    const rect = PHOTO_ATLAS_RECTS[String(obs.id)];
    if (!rect) throw new Error(`No photo atlas cell exists for ${obs.id}.`);
    const [u, v, w, h] = rect;
    const sx = u * atlas.naturalWidth;
    const sy = v * atlas.naturalHeight;
    const sw = w * atlas.naturalWidth;
    const sh = h * atlas.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D is unavailable for photo preparation.');
    ctx.drawImage(atlas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas);
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    obs.photo = url;
  }
}

window.addEventListener('pagehide', () => {
  for (const url of blobUrls) URL.revokeObjectURL(url);
}, {once: true});

try {
  status.textContent = 'Preparing trip photos…';
  await makePhotoUrls();
  status.textContent = 'Starting map…';
  await import('./app.js');
} catch (error) {
  const message = error?.message || String(error);
  console.error(error);
  status.classList.remove('ready');
  status.textContent = `Startup error: ${message}`;
  info.innerHTML = `<b>Memory Map could not start</b><span>${message}</span>`;
}
