export class CascadeSimulation {
  constructor(config = {}) {
    this.size = config.size ?? 64;
    this.cellSize = config.cellSize ?? 1.25;
    this.fixedDt = config.fixedDt ?? 1 / 30;
    this.flowScale = 1;
    this.frictionScale = 1;
    this.reset(config.seed ?? 1337);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.rngState = seed >>> 0;
    const n = this.size * this.size;
    this.height = new Float32Array(n);
    this.snow = new Float32Array(n);
    this.stability = new Float32Array(n);
    this.forest = new Float32Array(n);
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
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  hashNoise(x, z, salt = 0) {
    let h = (x * 374761393 + z * 668265263 + this.seed * 69069 + salt * 362437) >>> 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  index(x, z) { return z * this.size + x; }
  inBounds(x, z) { return x >= 0 && z >= 0 && x < this.size && z < this.size; }

  buildMountain() {
    const s = this.size;
    const phaseA = (this.seed % 997) * 0.013;
    const phaseB = (this.seed % 577) * 0.021;

    for (let z = 0; z < s; z++) {
      for (let x = 0; x < s; x++) {
        const nx = (x / (s - 1)) * 2 - 1;
        const nz = z / (s - 1);
        const ridgeShift = (this.hashNoise(4, 9, 1) - 0.5) * 0.28;
        const bowlShift = (this.hashNoise(8, 3, 2) - 0.5) * 0.35;
        const ridge = 32 * Math.pow(nz, 1.35);
        const bowl = -7.5 * Math.exp(-Math.pow((nx - bowlShift) * 2.15, 2)) * Math.pow(nz, 1.7);
        const east = -4.8 * Math.exp(-Math.pow((nx - (0.42 + ridgeShift)) * 5, 2)) * Math.pow(nz, 1.35);
        const west = 3.2 * Math.exp(-Math.pow((nx + 0.55 - ridgeShift * 0.5) * 4, 2)) * Math.pow(nz, 1.8);
        const seededRough = (
          Math.sin(x * 0.43 + phaseA) +
          Math.cos(z * 0.36 + phaseB) +
          Math.sin((x + z) * 0.19 + phaseA * 0.7) +
          (this.hashNoise(x, z, 3) - 0.5) * 1.2
        ) * 0.34;

        const i = this.index(x, z);
        this.height[i] = ridge + bowl + east + west + seededRough;

        const upper = smoothstep(0.28, 0.9, nz);
        const center = Math.exp(-Math.pow((nx - bowlShift * 0.45) * 1.35, 2));
        this.snow[i] = 0.15 + upper * (1.5 + 1.35 * center) + (this.hashNoise(x, z, 4) - 0.5) * 0.16;

        const bandCenter = 0.72 + (this.hashNoise(12, 7, 5) - 0.5) * 0.08;
        const band = Math.exp(-Math.pow((nz - bandCenter) * 12, 2));
        const pocketX = -0.12 + (this.hashNoise(2, 13, 6) - 0.5) * 0.36;
        const pocket = Math.exp(-Math.pow((nx - pocketX) * 5, 2)) * Math.exp(-Math.pow((nz - 0.68) * 7, 2));
        this.stability[i] = clamp(0.86 - band * 0.42 - pocket * 0.35 + (this.hashNoise(x, z, 7) - 0.5) * 0.1, 0.08, 0.96);

        const treeLine = 1 - smoothstep(0.58, 0.78, nz);
        const standA = Math.exp(-Math.pow((nx + 0.48) * 3.8, 2)) * Math.exp(-Math.pow((nz - 0.42) * 5.2, 2));
        const standB = Math.exp(-Math.pow((nx - 0.28) * 4.5, 2)) * Math.exp(-Math.pow((nz - 0.34) * 6.2, 2));
        const forestNoise = this.hashNoise(x, z, 8);
        this.forest[i] = clamp(treeLine * (standA * 0.95 + standB * 0.8 + forestNoise * 0.18 - 0.08), 0, 1);
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
        this.stability[this.index(x, z)] -= (1 - d / (radius + 0.01)) * 0.85 * power;
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
      const stress = this.neighborFractureRatio(x, z) * 0.28;
      if (this.stability[i] - stress > 0.38 || this.snow[i] < 0.35) continue;
      this.fractured[i] = 1;
      const mass = this.snow[i] * 0.72;
      this.snow[i] -= mass;
      this.moving[i] += mass;
      released += mass;
      for (const [nx, nz] of neighbors8(x, z)) if (this.inBounds(nx, nz)) queue.push([nx, nz]);
    }

    this.totalReleased += released;
    this.active = released > 0.05;
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

    for (let z = 1; z < this.size - 1; z++) {
      for (let x = 1; x < this.size - 1; x++) {
        const i = this.index(x, z);
        const mass = this.moving[i];
        if (mass < 0.003) continue;

        const forestDrag = this.forest[i];
        const current = this.height[i] + this.snow[i] + mass * 0.12;
        const candidates = [];
        let totalDrop = 0;

        for (const [nx, nz] of neighbors8(x, z)) {
          const ni = this.index(nx, nz);
          const drop = current - (this.height[ni] + this.snow[ni] + this.moving[ni] * 0.08);
          if (drop > 0.02) {
            candidates.push([ni, drop]);
            totalDrop += drop;
          }
        }

        const energy = Math.min(1, totalDrop / 6);
        const braking = 0.075 * this.frictionScale + forestDrag * 0.34;
        const speed = clamp(this.velocity[i] + energy * 0.34 * this.flowScale - braking, 0, 2.6 * this.flowScale);
        const movementPenalty = 1 - forestDrag * 0.72;
        const fraction = clamp((0.18 + speed * 0.22) * movementPenalty, 0.025, 0.78);
        const outgoing = candidates.length ? mass * fraction : 0;
        let retained = mass - outgoing;

        const intercepted = Math.min(retained, mass * forestDrag * 0.075);
        retained -= intercepted;
        this.snow[i] += intercepted;
        this.nextMoving[i] += retained;

        if (candidates.length) {
          for (const [ni, drop] of candidates) {
            const destinationForest = this.forest[ni];
            const amount = outgoing * (drop / totalDrop) * (1 - destinationForest * 0.28);
            const entrain = Math.min(this.snow[ni] * 0.12 * speed * (1 - destinationForest * 0.7), amount * 0.45);
            this.snow[ni] -= entrain;
            this.nextMoving[ni] += amount + entrain;
            this.totalReleased += entrain;
            this.velocity[ni] = Math.max(this.velocity[ni], speed * (1 - destinationForest * 0.62));
          }
        } else {
          this.snow[i] += retained * 0.28;
          this.nextMoving[i] -= retained * 0.28;
        }

        this.velocity[i] *= 0.82 * (1 - forestDrag * 0.55);
        activeMass += this.nextMoving[i];
      }
    }

    [this.moving, this.nextMoving] = [this.nextMoving, this.moving];
    if (activeMass < 0.45) this.settledFrames++;
    else this.settledFrames = 0;
    if (this.settledFrames > 45 || this.elapsed > 18) this.active = false;
  }

  sampleWorldHeight(x, z) {
    const gx = clamp(Math.round(x / this.cellSize + this.size / 2), 0, this.size - 1);
    const gz = clamp(Math.round(z / this.cellSize + this.size / 2), 0, this.size - 1);
    return this.height[this.index(gx, gz)];
  }

  worldPosition(x, z) {
    const i = this.index(x, z);
    return {
      x: (x - this.size / 2) * this.cellSize,
      y: this.height[i] + this.snow[i] + 0.18,
      z: (z - this.size / 2) * this.cellSize,
    };
  }
}

function neighbors8(x, z) {
  return [[x-1,z-1],[x,z-1],[x+1,z-1],[x-1,z],[x+1,z],[x-1,z+1],[x,z+1],[x+1,z+1]];
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function smoothstep(a, b, v) { const t = clamp((v-a)/(b-a),0,1); return t*t*(3-2*t); }
