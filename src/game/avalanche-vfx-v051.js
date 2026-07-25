import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithRibbonVFX() {
  originalBuildScene.call(this);

  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  const n = this.sim.size * this.sim.size;
  this.vfxMoving = new Float32Array(n);
  this.vfxDeposit = new Float32Array(n);
  this.vfxPowder = new Float32Array(n);
  this.vfxRibbons = [];
  this.vfxDepositRibbons = [];
  this.vfxFrame = 0;

  this.vfxSprayMesh = BABYLON.MeshBuilder.CreateSphere('vfxSpray051', { diameter: 1, segments: 5 }, this.scene);
  const sprayMaterial = this.mat('vfxSprayMat051', new BABYLON.Color3(1, .98, 1), .98);
  sprayMaterial.alpha = .46;
  sprayMaterial.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  sprayMaterial.emissiveColor = new BABYLON.Color3(.07, .06, .08);
  this.vfxSprayMesh.material = sprayMaterial;
  this.vfxSprayMesh.isPickable = false;
  this.vfxSprayMesh.alwaysSelectAsActiveMesh = true;
};

CascadeScene.prototype.updateFlow = function updateRibbonVFX() {
  this.vfxFrame++;
  const n = this.vfxMoving.length;
  for (let i = 0; i < n; i++) {
    this.vfxMoving[i] = Math.max(this.sim.moving[i] + this.sim.core[i] * .42, this.vfxMoving[i] * .982);
    this.vfxDeposit[i] = Math.max(this.sim.deposit[i], this.vfxDeposit[i] * .99985);
    this.vfxPowder[i] = Math.max(this.sim.powder[i], this.vfxPowder[i] * .95);
  }

  if (this.vfxFrame % 3 !== 0) return;

  const movingNodes = buildNodes.call(this, this.vfxMoving, .018);
  const depositNodes = buildNodes.call(this, this.vfxDeposit, .028);
  const movingPaths = tracePaths.call(this, movingNodes, 6, 18);
  const depositPaths = tracePaths.call(this, depositNodes, 5, 20);

  rebuildRibbonSet.call(this, 'moving', this.vfxRibbons, movingPaths,
    new BABYLON.Color3(.985, .975, 1), .62, .16, .82);
  rebuildRibbonSet.call(this, 'deposit', this.vfxDepositRibbons, depositPaths,
    new BABYLON.Color3(.93, .93, .97), .34, .08, .44);

  const spray = [];
  const energetic = movingNodes
    .filter(node => node.mass > .18 || node.powder > .06)
    .sort((a, b) => (b.mass + b.powder * 1.4) - (a.mass + a.powder * 1.4))
    .slice(0, 8);

  for (const node of energetic) {
    const count = 5 + Math.floor(Math.min(9, Math.sqrt(node.mass + node.powder) * 5));
    const sideX = -node.dir.z;
    const sideZ = node.dir.x;
    for (let i = 0; i < count; i++) {
      const a = hash(node.gx + i * 7, node.gz - i * 5, 13);
      const b = hash(node.gx - i * 3, node.gz + i * 11, 29);
      const forward = .4 + a * 3.2;
      const side = (b - .5) * (1.6 + Math.sqrt(node.mass) * 2.4);
      const size = .07 + a * .13;
      pushMatrix(spray,
        node.x + node.dir.x * forward + sideX * side,
        node.y + .7 + b * (1.4 + Math.sqrt(node.mass) * 1.5),
        node.z + node.dir.z * forward + sideZ * side,
        size, size, size);
    }
  }

  this.vfxSprayMesh.thinInstanceSetBuffer('matrix', new Float32Array(spray), 16, true);
};

function buildNodes(field, threshold) {
  const nodes = [];
  const size = this.sim.size;
  const step = 3;
  for (let gz = 2; gz < size - 2; gz += step) {
    for (let gx = 2; gx < size - 2; gx += step) {
      let mass = 0;
      let powder = 0;
      let weightedX = 0;
      let weightedZ = 0;
      let weight = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const z = gz + dz;
          const i = this.sim.index(x, z);
          const value = field[i];
          mass += value;
          powder += this.vfxPowder[i];
          weightedX += x * value;
          weightedZ += z * value;
          weight += value;
        }
      }
      if (mass < threshold || weight <= 0) continue;
      const cx = weightedX / weight;
      const cz = weightedZ / weight;
      const x = (cx - size / 2) * this.sim.cellSize;
      const z = (cz - size / 2) * this.sim.cellSize;
      const y = this.sim.sampleWorldHeight(x, z);
      const dir = directionAt.call(this, cx, cz);
      nodes.push({ gx, gz, cx, cz, x, y, z, mass, powder, dir, used: false });
    }
  }
  return nodes;
}

function tracePaths(nodes, maxPaths, maxLength) {
  const paths = [];
  const candidates = [...nodes].sort((a, b) => b.y - a.y || b.mass - a.mass);

  for (const start of candidates) {
    if (paths.length >= maxPaths) break;
    if (start.used || start.mass < .035) continue;

    const path = [];
    let current = start;
    for (let i = 0; i < maxLength && current; i++) {
      current.used = true;
      path.push(current);
      current = bestDownhillNeighbor(current, nodes);
    }

    if (path.length >= 3) paths.push(path);
  }
  return paths;
}

function bestDownhillNeighbor(current, nodes) {
  let best = null;
  let bestScore = Infinity;
  for (const node of nodes) {
    if (node.used || node.y >= current.y + .2) continue;
    const dx = node.x - current.x;
    const dz = node.z - current.z;
    const dist = Math.hypot(dx, dz);
    if (dist < .5 || dist > 8.2) continue;
    const alignment = (dx * current.dir.x + dz * current.dir.z) / dist;
    if (alignment < .05) continue;
    const score = dist * 1.1 - alignment * 4 - Math.sqrt(node.mass) * .45 + node.y * .002;
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

function rebuildRibbonSet(kind, store, paths, color, alpha, lift, widthScale) {
  while (store.length) store.pop().dispose();

  for (let p = 0; p < paths.length; p++) {
    const path = paths[p];
    const left = [];
    const right = [];

    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const nx = -tz;
      const nz = tx;
      const width = (1.5 + Math.min(5.2, Math.sqrt(node.mass) * 2.6)) * widthScale;
      const crown = Math.min(1.4, Math.sqrt(node.mass) * .42);
      left.push(new BABYLON.Vector3(node.x + nx * width, node.y + lift + crown * .55, node.z + nz * width));
      right.push(new BABYLON.Vector3(node.x - nx * width, node.y + lift + crown * .55, node.z - nz * width));
    }

    const mesh = BABYLON.MeshBuilder.CreateRibbon(`${kind}Ribbon${p}`, {
      pathArray: [left, right],
      closeArray: false,
      closePath: false,
      sideOrientation: BABYLON.Mesh.DOUBLESIDE
    }, this.scene);

    const material = this.mat(`${kind}RibbonMat${p}`, color, .92);
    material.alpha = alpha;
    material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    material.emissiveColor = color.scale(kind === 'moving' ? .08 : .025);
    material.backFaceCulling = false;
    mesh.material = material;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    store.push(mesh);
  }
}

function directionAt(cx, cz) {
  const x = Math.max(1, Math.min(this.sim.size - 2, Math.round(cx)));
  const z = Math.max(1, Math.min(this.sim.size - 2, Math.round(cz)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right;
  const dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function pushMatrix(arr, x, y, z, sx, sy, sz) {
  const matrix = BABYLON.Matrix.Compose(
    new BABYLON.Vector3(sx, sy, sz),
    BABYLON.Quaternion.Identity(),
    new BABYLON.Vector3(x, y, z)
  );
  arr.push(...matrix.toArray());
}

function hash(x, z, salt) {
  let h = (x * 374761393 + z * 668265263 + salt * 69069) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
