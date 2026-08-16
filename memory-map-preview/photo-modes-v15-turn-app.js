import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';

const originalEaseTo = maplibregl.Map.prototype.easeTo;
const originalStop = maplibregl.Map.prototype.stop;
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const shortestBearingDelta = (from, to) => ((to - from + 540) % 360) - 180;

maplibregl.Map.prototype.stop = function patchedStop(...args) {
  this.__memoryLiftToken = (this.__memoryLiftToken || 0) + 1;
  if (this.__memoryLiftFrame) cancelAnimationFrame(this.__memoryLiftFrame);
  this.__memoryLiftFrame = 0;
  return originalStop.apply(this, args);
};

maplibregl.Map.prototype.easeTo = function patchedEaseTo(options = {}, eventData) {
  const duration = Number(options.duration || 0);
  const targetZoom = Number(options.zoom);
  const targetPitch = Number(options.pitch);
  const targetBearing = Number(options.bearing);
  const currentCenter = this.getCenter();
  const targetCenter = options.center ? maplibregl.LngLat.convert(options.center) : currentCenter;
  const centerShift = Math.abs(targetCenter.lng - currentCenter.lng) + Math.abs(targetCenter.lat - currentCenter.lat);

  const isClusterLift =
    duration >= 3200 && duration <= 3600 &&
    Number.isFinite(targetZoom) && Math.abs(targetZoom - 16.4) < 0.05 &&
    Number.isFinite(targetPitch) && Math.abs(targetPitch - 58) < 0.5 &&
    Number.isFinite(targetBearing) &&
    centerShift < 0.00008;

  if (!isClusterLift) return originalEaseTo.call(this, options, eventData);

  originalStop.call(this);
  this.__memoryLiftToken = (this.__memoryLiftToken || 0) + 1;
  const token = this.__memoryLiftToken;
  const fixedCenter = currentCenter;
  const startZoom = this.getZoom();
  const startPitch = this.getPitch();
  const startBearing = this.getBearing();
  const bearingDelta = shortestBearingDelta(startBearing, targetBearing);
  const startedAt = performance.now();

  const frame = (now) => {
    if (token !== this.__memoryLiftToken) return;
    const raw = Math.min(1, (now - startedAt) / duration);
    const liftT = easeInOutCubic(raw);
    const turnT = easeInOutSine(raw);

    this.jumpTo({
      center: fixedCenter,
      zoom: lerp(startZoom, targetZoom, liftT),
      pitch: lerp(startPitch, targetPitch, liftT),
      bearing: startBearing + bearingDelta * turnT
    });

    if (raw < 1) {
      this.__memoryLiftFrame = requestAnimationFrame(frame);
    } else {
      this.__memoryLiftFrame = 0;
    }
  };

  this.__memoryLiftFrame = requestAnimationFrame(frame);
  return this;
};

await import('./photo-modes-v14-app.js');
