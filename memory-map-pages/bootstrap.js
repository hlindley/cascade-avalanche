import {ALL_OBS} from './data.js';

const status = document.getElementById('status');
const info = document.getElementById('info');
const ATLAS_URL = './photos/atlas.jpg';
const ORDER = ['1300','1303','1304','1308','1311','1313','1314','1315','1317','1320','1322','1323'];
const COLS = 4;
const ROWS = 3;
const blobUrls = [];

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not decode ${url}`));
    image.src = url;
  });
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas JPEG encoding returned no data.')), 'image/jpeg', 0.88);
  });
}

async function makePhotoUrls() {
  const atlas = await loadImage(ATLAS_URL);
  const cellW = atlas.naturalWidth / COLS;
  const cellH = atlas.naturalHeight / ROWS;
  const byId = new Map(ALL_OBS.map(obs => [String(obs.id), obs]));

  for (let index = 0; index < ORDER.length; index++) {
    const id = ORDER[index];
    const obs = byId.get(id);
    if (!obs) continue;
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cellW));
    canvas.height = Math.max(1, Math.round(cellH));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D is unavailable for photo preparation.');
    ctx.drawImage(atlas, col * cellW, row * cellH, cellW, cellH, 0, 0, canvas.width, canvas.height);
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
