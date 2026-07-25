export class CascadeSimulation {
  constructor(config = {}) {
    this.size = config.size ?? 64;
    this.cellSize = config.cellSize ?? 1.25;
    this.fixedDt = config.fixedDt ?? 1 / 30;
    this.reset(config.seed ?? 1337);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.rngState = seed >>> 0;
    const n = this.size * this.size;
    this.height = new Float32Array(n);
    this.snow = new Float32Array(n);
    this.stability = new Float32Array(n);
    this.fractured = new Uint8Array(n);
    this.moving = new Float32Array(n);
    this.nextMoving = new Float32Array(n);
    this.velocity = new Float32Array(n);
    this.totalReleased = 0;
    this.elapsed = 0;
    this.active = false;
    this.settledFrames = 0;
    this.buildMountain();
  }

  random() {
    let x = this.rngState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  index(x, z) { return z * this.size + x; }
  inBounds(x, z) { return x >= 0 && z >= 0 && x < this.size && z < this.size; }

  buildMountain() {
    const s = this.size;
    for (let z = 0; z < s; z++) {
      for (let x = 0; x < s; x++) {
        const nx = (x / (s - 1)) * 2 - 1;
        const nz = z / (s - 1);
        const ridge = 32 * Math.pow(nz, 1.35);
        const bowl = -7.5 * Math.exp(-Math.pow(nx * 2.15, 2)) * Math.pow(nz, 1.7);
        const eastGully = -4.8 * Math.exp(-Math.pow((nx - .42) * 5.0, 2)) * Math.pow(nz, 1.35);
        const westShoulder = 3.2 * Math.exp(-Math.pow((nx + .55) * 4.0, 2)) * Math.pow(nz, 1.8);
        const rough = (Math.sin(x * .43) + Math.cos(z * .36) + Math.sin((x + z) * .19)) * .28;
        const h = ridge + bowl + eastGully + westShoulder + rough;
        const i = this.index(x, z);
        this.height[i] = h;
        const upper = smoothstep(.28, .9, nz);
        const centerSlab = Math.exp(-Math.pow(nx * 1.35, 2));
        this.snow[i] = .15 + upper * (1.5 + 1.35 * centerSlab);
        const weakBand = Math.exp(-Math.pow((nz - .74) * 12, 2));
        const weakPocket = Math.exp(-Math.pow((nx + .12) * 5, 2)) * Math.exp(-Math.pow((nz - .68) * 7, 2));
        this.stability[i] = clamp(.86 - weakBand * .42 - weakPocket * .35 + (this.random() - .5) * .08, .08, .96);
      }
    }
  }

  triggerAt(worldX, worldZ, power = 1) {
    const gx = Math.round(worldX / this.cellSize + this.size / 2);
    const gz = Math.round(worldZ / this.cellSize + this.size / 2);
    if (!this.inBounds(gx, gz)) return false;
    const radius = 2 + Math.floor(power * 2);
    let released = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = gx + dx, z = gz + dz;
        if (!this.inBounds(x, z)) continue;
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const i = this.index(x, z);
        this.stability[i] -= (1 - d / (radius + .01)) * .85 * power;
      }
    }
    const queue = [[gx, gz]];
    const visited = new Uint8Array(this.size * this.size);
    while (queue.length) {
      const [x, z] = queue.shift();
      if (!this.inBounds(x, z)) continue;
      const i = this.index(x, z);
      if (visited[i]) continue;
      visited[i] = 1;
      const localStress = this.neighborFractureRatio(x, z) * .28;
      if (this.stability[i] - localStress > .38 || this.snow[i] < .35) continue;
      this.fractured[i] = 1;
      const mass = this.snow[i] * .72;
      this.snow[i] -= mass;
      this.moving[i] += mass;
      released += mass;
      for (const [nx, nz] of neighbors8(x, z)) {
        if (this.inBounds(nx, nz)) queue.push([nx, nz]);
      }
    }
    this.totalReleased += released;
    this.active = released > .05;
    return this.active;
  }

  neighborFractureRatio(x, z) {
    let count = 0, fractured = 0;
    for (const [nx, nz] of neighbors8(x, z)) {
      if (!this.inBounds(nx, nz)) continue;
      count++;
      fractured += this.fractured[this.index(nx, nz)] ? 1 : 0;
    }
    return count ? fractured / count : 0;
  }

  step(dt = this.fixedDt) {
    if (!this.active) return;
    this.elapsed += dt;
    this.nextMoving.fill(0);
    let activeMass = 0;
    const s = this.size;
    for (let z = 1; z < s - 1; z++) {
      for (let x = 1; x < s - 1; x++) {
        const i = this.index(x, z);
        const mass = this.moving[i];
        if (mass < .003) continue;
        const currentSurface = this.height[i] + this.snow[i] + mass * .12;
        const candidates = [];
        let totalDrop = 0;
        for (const [nx, nz] of neighbors8(x, z)) {
          if (!this.inBounds(nx, nz)) continue;
          const ni = this.index(nx, nz);
          const drop = currentSurface - (this.height[ni] + this.snow[ni] + this.moving[ni] * .08);
          if (drop > .02) { candidates.push([ni, drop]); totalDrop += drop; }
        }
        const slopeEnergy = Math.min(1, totalDrop / 6);
        const speed = clamp(this.velocity[i] + slopeEnergy * .34 - .075, 0, 2.6);
        const moveFraction = clamp(.18 + speed * .22, .08, .78);
        const outgoing = candidates.length ? mass * moveFraction : 0;
        const retained = mass - outgoing;
        this.nextMoving[i] += retained;
        if (candidates.length) {
          for (const [ni, drop] of candidates) {
            const amount = outgoing * (drop / totalDrop);
            const entrain = Math.min(this.snow[ni] * .12 * speed, amount * .45);
            this.snow[ni] -= entrain;
            this.nextMoving[ni] += amount + entrain;
            this.totalReleased += entrain;
            this.velocity[ni] = Math.max(this.velocity[ni], speed);
          }
        } else {
          this.snow[i] += retained * .28;
          this.nextMoving[i] -= retained * .28;
        }
        this.velocity[i] *= .82;
        activeMass += this.nextMoving[i];
      }
    }
    [this.moving, this.nextMoving] = [this.nextMoving, this.moving];
    if (activeMass < .45) this.settledFrames++; else this.settledFrames = 0;
    if (this.settledFrames > 45 || this.elapsed > 18) this.active = false;
  }

  sampleWorldHeight(worldX, worldZ) {
    const gx = clamp(Math.round(worldX / this.cellSize + this.size / 2), 0, this.size - 1);
    const gz = clamp(Math.round(worldZ / this.cellSize + this.size / 2), 0, this.size - 1);
    return this.height[this.index(gx, gz)];
  }

  worldPosition(x, z) {
    const i = this.index(x, z);
    return {
      x: (x - this.size / 2) * this.cellSize,
      y: this.height[i] + this.snow[i] + .18,
      z: (z - this.size / 2) * this.cellSize,
    };
  }
}

function neighbors8(x, z) {
  return [[x-1,z-1],[x,z-1],[x+1,z-1],[x-1,z],[x+1,z],[x-1,z+1],[x,z+1],[x+1,z+1]];
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function smoothstep(a, b, v) { const t = clamp((v-a)/(b-a),0,1); return t*t*(3-2*t); }
