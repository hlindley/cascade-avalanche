export class PhotoTextureLayer {
  constructor(id = 'photo-texture-v15') {
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '2d';
    this.map = null;
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.texture = null;
    this.aPos = -1;
    this.uTexture = null;
    this.uOpacity = null;
    this.uUvScale = null;
    this.opacity = 0;
    this.targetOpacity = 0;
    this.animationStartOpacity = 0;
    this.animationStartTime = 0;
    this.animationDuration = 420;
    this.isAnimating = false;
    this.hasTexture = false;
    this.imageWidth = 1;
    this.imageHeight = 1;
    this.loadToken = 0;
    this.currentUrl = '';
    this.pendingSource = null;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this._createResources(gl);
    if (this.pendingSource) {
      this._uploadSource(this.pendingSource);
      this.pendingSource.close?.();
      this.pendingSource = null;
    }
  }

  _createResources(gl) {
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const vertexSource = webgl2 ? `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
        v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - ((a_pos.y + 1.0) * 0.5));
      }
    ` : `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
        v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - ((a_pos.y + 1.0) * 0.5));
      }
    `;
    const fragmentSource = webgl2 ? `#version 300 es
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_opacity;
      uniform vec2 u_uvScale;
      in vec2 v_uv;
      out vec4 fragColor;
      void main() {
        vec2 uv = (v_uv - 0.5) * u_uvScale + 0.5;
        vec3 rgb = texture(u_texture, uv).rgb;
        fragColor = vec4(rgb, u_opacity);
      }
    ` : `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_opacity;
      uniform vec2 u_uvScale;
      varying vec2 v_uv;
      void main() {
        vec2 uv = (v_uv - 0.5) * u_uvScale + 0.5;
        vec3 rgb = texture2D(u_texture, uv).rgb;
        gl_FragColor = vec4(rgb, u_opacity);
      }
    `;

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'Unknown shader compile failure';
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    };

    const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program) || 'Photo shader failed to link');
    }

    this.aPos = gl.getAttribLocation(this.program, 'a_pos');
    this.uTexture = gl.getUniformLocation(this.program, 'u_texture');
    this.uOpacity = gl.getUniformLocation(this.program, 'u_opacity');
    this.uUvScale = gl.getUniformLocation(this.program, 'u_uvScale');

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1
    ]), gl.STATIC_DRAW);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  }

  async setPhoto(url) {
    if (!url) return false;
    const token = ++this.loadToken;
    this.currentUrl = url;
    try {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Photo request failed (${response.status})`);
      const blob = await response.blob();
      let source;
      if ('createImageBitmap' in window) {
        try {
          source = await createImageBitmap(blob);
        } catch {
          source = await this._blobToImage(blob);
        }
      } else {
        source = await this._blobToImage(blob);
      }
      if (token !== this.loadToken) {
        source.close?.();
        return false;
      }
      this.imageWidth = source.width || source.naturalWidth || 1;
      this.imageHeight = source.height || source.naturalHeight || 1;
      if (this.gl) {
        this._uploadSource(source);
        source.close?.();
      } else {
        this.pendingSource?.close?.();
        this.pendingSource = source;
      }
      this.hasTexture = true;
      this.map?.triggerRepaint();
      return true;
    } catch (error) {
      if (token === this.loadToken) {
        this.hasTexture = false;
        this.hide(0);
      }
      console.warn('Photo texture failed', error);
      return false;
    }
  }

  _blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Browser could not decode the photograph')); };
      image.src = url;
    });
  }

  _uploadSource(source) {
    const gl = this.gl;
    if (!gl || !this.texture) return;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  show(duration = 420) { this._animateTo(1, duration); }
  hide(duration = 320) { this._animateTo(0, duration); }
  toggle(duration = 420) { this._animateTo(this.isVisible() ? 0 : 1, duration); }
  isVisible() { return this.targetOpacity > 0.5 || this.opacity > 0.5; }

  _animateTo(target, duration) {
    this.animationStartOpacity = this.opacity;
    this.targetOpacity = this.hasTexture ? target : 0;
    this.animationStartTime = performance.now();
    this.animationDuration = Math.max(0, duration);
    this.isAnimating = this.animationDuration > 0 && Math.abs(this.targetOpacity - this.opacity) > 0.001;
    if (!this.isAnimating) this.opacity = this.targetOpacity;
    this.map?.triggerRepaint();
  }

  render(first) {
    const gl = first?.gl || first;
    this._updateAnimation();
    if (!gl || !this.hasTexture || this.opacity <= 0.001) {
      if (this.isAnimating) this.map?.triggerRepaint();
      return;
    }

    const canvas = this.map.getCanvas();
    const canvasAspect = Math.max(0.001, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const imageAspect = Math.max(0.001, this.imageWidth / Math.max(1, this.imageHeight));
    let scaleX = 1, scaleY = 1;
    if (imageAspect > canvasAspect) scaleX = canvasAspect / imageAspect;
    else scaleY = imageAspect / canvasAspect;

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uTexture, 0);
    gl.uniform1f(this.uOpacity, this.opacity);
    gl.uniform2f(this.uUvScale, scaleX, scaleY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.depthMask(true);

    if (this.isAnimating) this.map.triggerRepaint();
  }

  _updateAnimation() {
    if (!this.isAnimating) return;
    const elapsed = performance.now() - this.animationStartTime;
    const t = Math.min(1, elapsed / this.animationDuration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.opacity = this.animationStartOpacity + (this.targetOpacity - this.animationStartOpacity) * eased;
    if (t >= 1) { this.opacity = this.targetOpacity; this.isAnimating = false; }
  }

  onRemove(map, gl) {
    ++this.loadToken;
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.program) gl.deleteProgram(this.program);
    this.pendingSource?.close?.();
    this.pendingSource = null;
    this.map = null;
    this.gl = null;
  }
}
