import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';
import {CLUSTERS} from './photo-modes-v13-data.js';
import {PHOTO_ATLAS_DATA_URL, PHOTO_ATLAS_RECTS} from './photo-atlas-v16-proto.js';

// Preserve the v15 camera behavior: the cluster-travel bearing turns throughout
// the vertical lift instead of snapping before the ascent begins.
const originalEaseTo = maplibregl.Map.prototype.easeTo;
const originalStop = maplibregl.Map.prototype.stop;
const originalOn = maplibregl.Map.prototype.on;
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

class MemoryPhotoLayer {
  constructor() {
    this.id = 'memory-photo-layer';
    this.type = 'custom';
    this.renderingMode = '2d';
    this.map = null;
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.vao = null;
    this.texture = null;
    this.ready = false;
    this.failed = false;
    this.opacity = 0;
    this.targetOpacity = 0;
    this.fadeToken = 0;
    this.observationId = '1300';
    this.rect = PHOTO_ATLAS_RECTS[this.observationId];
    this.listeners = new Set();
    this._readyResolved = false;
    this.readyPromise = new Promise((resolve) => { this._resolveReady = resolve; });
  }

  onStatus(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, detail = {}) {
    for (const listener of this.listeners) {
      try { listener({type, ...detail}); } catch (error) { console.warn('Photo status listener failed', error); }
    }
  }

  attachMap(map) {
    this.map = map;
  }

  compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not allocate photo shader.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unknown shader compile error.';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.ready = false;
    this.failed = false;

    try {
      const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      const vertexSource = isWebGL2 ? `#version 300 es
        in vec2 a_pos;
        in vec2 a_uv;
        out vec2 v_uv;
        void main() {
          v_uv = a_uv;
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }` : `
        attribute vec2 a_pos;
        attribute vec2 a_uv;
        varying vec2 v_uv;
        void main() {
          v_uv = a_uv;
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }`;

      const fragmentSource = isWebGL2 ? `#version 300 es
        precision mediump float;
        in vec2 v_uv;
        uniform sampler2D u_texture;
        uniform vec4 u_uvRect;
        uniform float u_opacity;
        out vec4 fragColor;
        void main() {
          vec2 uv = mix(u_uvRect.xy, u_uvRect.zw, v_uv);
          vec3 rgb = texture(u_texture, uv).rgb;
          fragColor = vec4(rgb * u_opacity, u_opacity);
        }` : `
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_texture;
        uniform vec4 u_uvRect;
        uniform float u_opacity;
        void main() {
          vec2 uv = mix(u_uvRect.xy, u_uvRect.zw, v_uv);
          vec3 rgb = texture2D(u_texture, uv).rgb;
          gl_FragColor = vec4(rgb * u_opacity, u_opacity);
        }`;

      const vertexShader = this.compileShader(gl, gl.VERTEX_SHADER, vertexSource);
      const fragmentShader = this.compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
      const program = gl.createProgram();
      if (!program) throw new Error('Could not allocate photo shader program.');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Unknown photo shader link error.');
      }

      this.program = program;
      this.aPos = gl.getAttribLocation(program, 'a_pos');
      this.aUv = gl.getAttribLocation(program, 'a_uv');
      this.uTexture = gl.getUniformLocation(program, 'u_texture');
      this.uUvRect = gl.getUniformLocation(program, 'u_uvRect');
      this.uOpacity = gl.getUniformLocation(program, 'u_opacity');

      const vertices = new Float32Array([
        -1, -1, 0, 0,
         1, -1, 1, 0,
        -1,  1, 0, 1,
         1,  1, 1, 1
      ]);
      this.buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

      if (isWebGL2 && gl.createVertexArray) {
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        this.bindVertexAttributes(gl);
        gl.bindVertexArray(null);
      }

      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

      this.loadAtlas();
    } catch (error) {
      this.fail(error);
    }
  }

  bindVertexAttributes(gl) {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 16, 8);
  }

  loadAtlas() {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (!this.gl || !this.texture) return;
      try {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.atlasWidth = image.naturalWidth || 360;
        this.atlasHeight = image.naturalHeight || 384;
        this.ready = true;
        this.failed = false;
        if (!this._readyResolved) {
          this._readyResolved = true;
          this._resolveReady(true);
        }
        this.emit('ready', {width: this.atlasWidth, height: this.atlasHeight});
        this.map?.triggerRepaint();
      } catch (error) {
        this.fail(error);
      }
    };
    image.onerror = () => this.fail(new Error('The compact photo atlas could not be decoded.'));
    image.src = PHOTO_ATLAS_DATA_URL;
  }

  fail(error) {
    console.error('Memory photo layer disabled:', error);
    this.failed = true;
    this.ready = false;
    this.opacity = 0;
    this.targetOpacity = 0;
    if (!this._readyResolved) {
      this._readyResolved = true;
      this._resolveReady(false);
    }
    this.emit('error', {error});
  }

  setObservation(id) {
    const rect = PHOTO_ATLAS_RECTS[String(id)];
    if (!rect) return false;
    this.observationId = String(id);
    this.rect = rect;
    this.map?.triggerRepaint();
    return true;
  }

  getUvRect(gl) {
    const [x, y, width, height] = this.rect || [0, 0, 1, 1];
    let u0 = x;
    let u1 = x + width;
    let v0 = 1 - (y + height);
    let v1 = 1 - y;

    const atlasWidth = this.atlasWidth || 360;
    const atlasHeight = this.atlasHeight || 384;
    const sourceAspect = (width * atlasWidth) / (height * atlasHeight);
    const viewportAspect = Math.max(1, gl.drawingBufferWidth) / Math.max(1, gl.drawingBufferHeight);

    // CSS object-fit: cover, performed within the selected atlas cell.
    if (sourceAspect > viewportAspect) {
      const visibleFraction = viewportAspect / sourceAspect;
      const crop = (u1 - u0) * (1 - visibleFraction) * 0.5;
      u0 += crop;
      u1 -= crop;
    } else {
      const visibleFraction = sourceAspect / viewportAspect;
      const crop = (v1 - v0) * (1 - visibleFraction) * 0.5;
      v0 += crop;
      v1 -= crop;
    }

    return [u0, v0, u1, v1];
  }

  render(glOrArgs) {
    const gl = glOrArgs?.gl || glOrArgs;
    if (!gl || !this.ready || this.failed || this.opacity <= 0.001 || !this.program || !this.texture) return;

    try {
      const [u0, v0, u1, v1] = this.getUvRect(gl);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.program);

      if (this.vao && gl.bindVertexArray) {
        gl.bindVertexArray(this.vao);
      } else {
        this.bindVertexAttributes(gl);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.uTexture, 0);
      gl.uniform4f(this.uUvRect, u0, v0, u1, v1);
      gl.uniform1f(this.uOpacity, this.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (this.vao && gl.bindVertexArray) gl.bindVertexArray(null);
      gl.depthMask(true);
    } catch (error) {
      this.fail(error);
    }
  }

  fadeTo(target, duration = 420) {
    target = Math.max(0, Math.min(1, target));
    this.targetOpacity = target;
    const token = ++this.fadeToken;
    const startOpacity = this.opacity;
    const startedAt = performance.now();

    return new Promise((resolve) => {
      const step = (now) => {
        if (token !== this.fadeToken) return resolve(false);
        const raw = duration <= 0 ? 1 : Math.min(1, (now - startedAt) / duration);
        const eased = easeInOutSine(raw);
        this.opacity = lerp(startOpacity, target, eased);
        this.map?.triggerRepaint();
        if (raw < 1) requestAnimationFrame(step);
        else {
          this.opacity = target;
          this.emit('visibility', {visible: target > 0.5});
          resolve(true);
        }
      };
      requestAnimationFrame(step);
    });
  }

  onRemove(_map, gl) {
    this.fadeToken++;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao && gl.deleteVertexArray) gl.deleteVertexArray(this.vao);
    this.texture = null;
    this.buffer = null;
    this.program = null;
    this.vao = null;
    this.ready = false;
    this.gl = null;
  }
}

const photoLayer = new MemoryPhotoLayer();
let capturedMap = null;
let mapListenersInstalled = false;

// Register an additional style-load listener before the v14 app registers its own.
// The zero-delay callback places the photo layer after all normal map layers.
maplibregl.Map.prototype.on = function patchedOn(type, ...rest) {
  if (type === 'style.load' && !this.__memoryPhotoStyleHook) {
    this.__memoryPhotoStyleHook = true;
    originalOn.call(this, 'style.load', () => {
      capturedMap = this;
      photoLayer.attachMap(this);
      setTimeout(() => {
        try {
          if (!this.getLayer(photoLayer.id)) this.addLayer(photoLayer);
          installMapListeners(this);
          scheduleSync();
        } catch (error) {
          photoLayer.fail(error);
        }
      }, 0);
    });
  }
  return originalOn.call(this, type, ...rest);
};

await import('./photo-modes-v14-app.js');

const photoButton = document.getElementById('photoBtn');
const povButton = document.getElementById('pov');
const poseChip = document.getElementById('pose');
const note = document.getElementById('note');
const clusterButtonIds = {
  flatiron: 'cluster-flatiron',
  noho: 'cluster-noho',
  central: 'cluster-central'
};
let selectedObservationId = null;
let photoShown = false;
let syncScheduled = false;

function isPov() {
  return povButton?.classList.contains('active') === true;
}

function currentSelection() {
  const clusterId = Object.entries(clusterButtonIds)
    .find(([, elementId]) => document.getElementById(elementId)?.classList.contains('active'))?.[0];
  if (!clusterId) return null;
  const cluster = CLUSTERS[clusterId];
  if (!cluster) return null;
  const dots = [...document.querySelectorAll('#dots .dot')];
  let index = dots.findIndex((dot) => dot.classList.contains('active'));
  if (index < 0) index = 0;
  return cluster.observations[Math.min(index, cluster.observations.length - 1)] || null;
}

function updatePhotoUi() {
  const observation = currentSelection();
  if (observation && String(observation.id) !== selectedObservationId) {
    selectedObservationId = String(observation.id);
    photoLayer.setObservation(selectedObservationId);
  }

  const mapIsMoving = capturedMap?.isMoving?.() === true;
  const canShow = Boolean(isPov() && !mapIsMoving && observation && photoLayer.ready && !photoLayer.failed);
  if (photoButton && photoButton.disabled === canShow) photoButton.disabled = !canShow;
  const ariaDisabled = String(!canShow);
  if (photoButton?.getAttribute('aria-disabled') !== ariaDisabled) photoButton?.setAttribute('aria-disabled', ariaDisabled);
  photoButton?.classList.toggle('photo-ready', canShow);
  photoButton?.classList.toggle('active', canShow && photoShown);

  if (!isPov() && photoShown) hidePhoto(160, false);
  if (photoShown && isPov() && poseChip) poseChip.textContent = 'POV · PHOTO';
}

function scheduleSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  requestAnimationFrame(() => {
    syncScheduled = false;
    updatePhotoUi();
  });
}

async function showPhoto() {
  const observation = currentSelection();
  if (!isPov() || !observation) return;
  if (!photoLayer.ready) {
    if (note) note.textContent = 'Preparing the in-canvas photo texture…';
    const ready = await photoLayer.readyPromise;
    if (!ready || !isPov()) return;
  }
  photoLayer.setObservation(observation.id);
  photoShown = true;
  document.body.classList.add('photo-visible');
  photoButton?.classList.add('active');
  if (poseChip) poseChip.textContent = 'POV · PHOTO';
  if (note) note.textContent = 'Actual photograph · tap Photo again to return to the reconstructed POV.';
  await photoLayer.fadeTo(1, 460);
  scheduleSync();
}

async function hidePhoto(duration = 320, updateCopy = true) {
  if (!photoShown && photoLayer.opacity <= 0.001) return;
  photoShown = false;
  document.body.classList.remove('photo-visible');
  photoButton?.classList.remove('active');
  await photoLayer.fadeTo(0, duration);
  if (isPov() && poseChip) poseChip.textContent = 'POV';
  if (updateCopy && note) note.textContent = 'Reconstructed POV · Photo is the same-perspective evidence toggle.';
  scheduleSync();
}

photoButton.onclick = null;
photoButton.addEventListener('click', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (photoShown || photoLayer.targetOpacity > 0.5) await hidePhoto();
  else await showPhoto();
});

// Any navigation action exits the evidence surface before the map moves.
document.addEventListener('pointerdown', (event) => {
  const button = event.target.closest?.('button');
  if (button && button !== photoButton && (photoShown || photoLayer.opacity > 0.001)) {
    hidePhoto(140, false);
  }
}, true);

function installMapListeners(map) {
  if (mapListenersInstalled) return;
  mapListenersInstalled = true;
  map.on('movestart', () => {
    if (photoShown || photoLayer.opacity > 0.001) hidePhoto(140, false);
  });
  map.on('moveend', scheduleSync);
}

photoLayer.onStatus(({type, error}) => {
  if (type === 'ready') {
    if (note && isPov()) note.textContent = 'Photo texture ready · tap Photo to compare.';
    scheduleSync();
  } else if (type === 'error') {
    photoShown = false;
    if (photoButton) photoButton.disabled = true;
    if (note) note.textContent = `Photo renderer unavailable; the map remains active. ${error?.message || ''}`.trim();
  } else if (type === 'visibility') {
    scheduleSync();
  }
});

const observer = new MutationObserver(scheduleSync);
observer.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class', 'disabled', 'aria-disabled']
});

// The atlas begins decoding only when the custom layer is added. Until then the
// existing v14 app remains fully usable and the Photo control stays disabled.
if (capturedMap) installMapListeners(capturedMap);
scheduleSync();
