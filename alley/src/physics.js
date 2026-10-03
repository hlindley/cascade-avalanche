import RAPIER from 'rapier';

// Collision membership bits (Rapier InteractionGroups: high 16 = membership, low 16 = filter).
export const G = {
  STATIC: 1 << 0,
  CELL: 1 << 1,
  DEBRIS: 1 << 2,
  MECH: 1 << 3,
  ATTACH: 1 << 4,
};
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);
export const ALL = 0xffff;

export const GROUP_STATIC = groups(G.STATIC, ALL);
export const GROUP_CELL = groups(G.CELL, ALL & ~G.CELL);
export const GROUP_DEBRIS = groups(G.DEBRIS, G.STATIC | G.CELL | G.DEBRIS | G.MECH | G.ATTACH);
export const GROUP_MECH = groups(G.MECH, ALL);
export const GROUP_ATTACH = groups(G.ATTACH, ALL & ~G.CELL);

export class Physics {
  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  constructor() {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81 * 1.25, z: 0 });
    this.world.timestep = 1 / 60;
    // collider handle -> owner record { kind, ... }
    this.owners = new Map();
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  setOwner(collider, owner) {
    this.owners.set(collider.handle, owner);
  }

  ownerOf(collider) {
    return collider ? this.owners.get(collider.handle) : undefined;
  }

  fixedBox(cx, cy, cz, hx, hy, hz, quat, owner = { kind: 'static' }) {
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.fixed().setTranslation(cx, cy, cz).setRotation(quat ?? { x: 0, y: 0, z: 0, w: 1 })
    );
    const col = this.world.createCollider(this.R.ColliderDesc.cuboid(hx, hy, hz).setCollisionGroups(GROUP_STATIC), body);
    this.setOwner(col, owner);
    return col;
  }

  // Ray query against everything except an optional excluded collider / predicate.
  castRay(origin, dir, maxDist, exclude, predicate) {
    this.ray.origin = origin;
    this.ray.dir = dir;
    const hit = this.world.castRayAndGetNormal(this.ray, maxDist, true, undefined, undefined, exclude, undefined, predicate);
    if (!hit) return null;
    return {
      collider: hit.collider,
      toi: hit.timeOfImpact,
      normal: hit.normal,
      owner: this.ownerOf(hit.collider),
    };
  }

  step() {
    this.world.step();
  }
}
