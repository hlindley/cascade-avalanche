import * as THREE from 'three';
import { mulberry32 } from './voronoi.js';

// All surface graphics are generated here (no external assets).

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

export function toTexture(c, repeat = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Tileable grime/aggregate: blobs drawn with wrap-around.
export function grain(ctx, w, h, seed, opts = {}) {
  const r = mulberry32(seed);
  const n = opts.count ?? 900;
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h;
    const rad = (opts.min ?? 1) + r() * ((opts.max ?? 6) - (opts.min ?? 1));
    const l = r() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${l},${l},${l},${(opts.alpha ?? 0.05) * r()})`;
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function concreteTexture(seed, base = '#cfc9bd', size = 512, opts = {}) {
  const [c, ctx] = canvas(size, size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, size, seed, { count: 260, min: 20, max: 90, alpha: 0.06 });
  grain(ctx, size, size, seed + 1, { count: 2600, min: 0.6, max: 2.4, alpha: 0.16 });
  if (opts.aggregate) grain(ctx, size, size, seed + 2, { count: 1600, min: 1.5, max: 4.5, alpha: 0.28 });
  return c;
}

export function concreteMap(seed, base, repeat = 1, opts) {
  return toTexture(concreteTexture(seed, base, 512, opts), repeat);
}

// Fracture core: warm aggregate with rebar-like dark flecks.
export function fractureMap() {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#9b9286';
  ctx.fillRect(0, 0, 256, 256);
  grain(ctx, 256, 256, 41, { count: 1400, min: 1, max: 5, alpha: 0.4 });
  grain(ctx, 256, 256, 42, { count: 300, min: 3, max: 9, alpha: 0.2 });
  const t = toTexture(c, 1);
  t.repeat.set(2.2, 2.2);
  return t;
}

export function plasterMap() {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#efe2cc';
  ctx.fillRect(0, 0, 256, 256);
  grain(ctx, 256, 256, 51, { count: 200, min: 10, max: 50, alpha: 0.05 });
  grain(ctx, 256, 256, 52, { count: 900, min: 0.5, max: 2, alpha: 0.08 });
  return toTexture(c, 1);
}

// Facade painter. `ops` are drawn in facade coordinates (metres: s along facade, y up);
// each panel renders only its own window of the shared design so graphics run continuously
// across infill fields and break apart with them.
export function paintPanel(design, s0, y0, w, h, ppm = 90) {
  const W = Math.ceil(w * ppm), H = Math.ceil(h * ppm);
  const [c, ctx] = canvas(W, H);
  ctx.save();
  // canvas y down; facade y up
  ctx.translate(-s0 * ppm, (y0 + h) * ppm);
  ctx.scale(ppm, -ppm);
  for (const op of design.ops) op(ctx, { s0, y0, w, h, ppm });
  ctx.restore();
  // weathering in panel space
  const r = mulberry32(Math.floor(s0 * 100 + y0 * 7));
  grain(ctx, W, H, Math.floor(s0 * 13 + y0), { count: Math.floor(W * H / 300), min: 0.5, max: 2.2, alpha: 0.1 });
  // streaks from above
  for (let i = 0; i < W / 18; i++) {
    const x = r() * W;
    const len = H * (0.2 + r() * 0.7);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, `rgba(60,52,44,${0.05 + r() * 0.08})`);
    g.addColorStop(1, 'rgba(60,52,44,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 1 + r() * 4, len);
  }
  // base grime
  const gb = ctx.createLinearGradient(0, H, 0, H - 1.2 * ppm);
  gb.addColorStop(0, 'rgba(50,42,36,0.32)');
  gb.addColorStop(1, 'rgba(50,42,36,0)');
  ctx.fillStyle = gb;
  ctx.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Helpers for facade design ops (facade coordinates, metres).
export const ops = {
  fill: (color) => (ctx, p) => { ctx.fillStyle = color; ctx.fillRect(p.s0 - 1, p.y0 - 1, p.w + 2, p.h + 2); },
  rect: (color, s, y, w, h) => (ctx) => { ctx.fillStyle = color; ctx.fillRect(s, y, w, h); },
  // formwork tie holes on a grid
  ties: (color, ds, dy, offS = 0.3, offY = 0.3) => (ctx, p) => {
    ctx.fillStyle = color;
    for (let s = Math.floor(p.s0 / ds) * ds + offS; s < p.s0 + p.w; s += ds)
      for (let y = Math.floor(p.y0 / dy) * dy + offY; y < p.y0 + p.h; y += dy) {
        ctx.beginPath(); ctx.arc(s, y, 0.035, 0, Math.PI * 2); ctx.fill();
      }
  },
  hlines: (color, dy, lw = 0.012) => (ctx, p) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    for (let y = Math.floor(p.y0 / dy) * dy; y < p.y0 + p.h; y += dy) { ctx.beginPath(); ctx.moveTo(p.s0, y); ctx.lineTo(p.s0 + p.w, y); ctx.stroke(); }
  },
  chevrons: (c1, c2, s, y, w, h, band = 0.45) => (ctx) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(s, y, w, h); ctx.clip();
    ctx.fillStyle = c1; ctx.fillRect(s, y, w, h);
    ctx.fillStyle = c2;
    for (let x = s - h * 2; x < s + w + h; x += band * 2) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + band, y); ctx.lineTo(x + band + h, y + h); ctx.lineTo(x + h, y + h); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  },
  text: (str, color, s, y, size, opts = {}) => (ctx) => {
    ctx.save();
    ctx.translate(s, y);
    ctx.scale(1, -1);
    ctx.fillStyle = color;
    ctx.font = `${opts.weight ?? 800} ${size}px ${opts.font ?? '"Helvetica Neue", Helvetica, Arial, sans-serif'}`;
    ctx.textBaseline = 'alphabetic';
    if (opts.spacing) ctx.letterSpacing = `${opts.spacing}px`;
    ctx.fillText(str, 0, 0);
    ctx.restore();
  },
  circle: (color, s, y, r) => (ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(s, y, r, 0, Math.PI * 2); ctx.fill(); },
};

// Ground: a large painted concrete slab with markings and stains.
export function groundTexture(size = 2048, metres = 80) {
  const [c, ctx] = canvas(size, size);
  const ppm = size / metres;
  ctx.fillStyle = '#8f8b84';
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, size, 61, { count: 1600, min: 10, max: 120, alpha: 0.05 });
  grain(ctx, size, size, 62, { count: 30000, min: 0.6, max: 2.2, alpha: 0.14 });
  const r = mulberry32(63);
  // slab joints
  ctx.strokeStyle = 'rgba(40,36,32,0.45)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= metres; i += 6) {
    ctx.beginPath(); ctx.moveTo(i * ppm + 0.5, 0); ctx.lineTo(i * ppm + 0.5, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * ppm + 0.5); ctx.lineTo(size, i * ppm + 0.5); ctx.stroke();
  }
  // oil / water stains
  for (let i = 0; i < 40; i++) {
    const x = r() * size, y = r() * size, rad = (1 + r() * 4) * ppm;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(30,28,26,${0.12 + r() * 0.15})`);
    g.addColorStop(1, 'rgba(30,28,26,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return { canvas: c, ctx, ppm, metres };
}
