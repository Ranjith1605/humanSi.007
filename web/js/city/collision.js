// Synergy City — collision. The city is walked at ground level, so footprints
// are axis-aligned boxes on the XZ plane and the player is a circle (radius).
// A coarse spatial grid keeps resolve() cheap even with hundreds of buildings.
export function makeCollision(cell = 20) {
  const boxes = []; // { minX, maxX, minZ, maxZ, tag }
  const grid = new Map(); // "cx,cz" -> array of box indices
  const key = (cx, cz) => cx + ',' + cz;

  function index(box, i) {
    const x0 = Math.floor(box.minX / cell);
    const x1 = Math.floor(box.maxX / cell);
    const z0 = Math.floor(box.minZ / cell);
    const z1 = Math.floor(box.maxZ / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(i);
      }
    }
  }

  function addBox(cx, cz, halfX, halfZ, { tag = '' } = {}) {
    const box = { minX: cx - halfX, maxX: cx + halfX, minZ: cz - halfZ, maxZ: cz + halfZ, tag };
    boxes.push(box);
    index(box, boxes.length - 1);
    return box;
  }

  function near(x, z) {
    const arr = grid.get(key(Math.floor(x / cell), Math.floor(z / cell)));
    return arr || EMPTY;
  }
  const EMPTY = [];

  // Push a circle (x,z,r) out of the nearest overlapping box along the shallowest axis.
  function resolve(position, radius) {
    for (let pass = 0; pass < 2; pass++) {
      const candidates = near(position.x, position.z);
      let hit = false;
      for (const i of candidates) {
        const b = boxes[i];
        const nx = Math.max(b.minX, Math.min(position.x, b.maxX));
        const nz = Math.max(b.minZ, Math.min(position.z, b.maxZ));
        const dx = position.x - nx;
        const dz = position.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 < radius * radius) {
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            position.x = nx + (dx / d) * radius;
            position.z = nz + (dz / d) * radius;
          } else {
            // Centre inside the box: eject along the nearest face.
            const left = position.x - b.minX;
            const right = b.maxX - position.x;
            const back = position.z - b.minZ;
            const front = b.maxZ - position.z;
            const m = Math.min(left, right, back, front);
            if (m === left) position.x = b.minX - radius;
            else if (m === right) position.x = b.maxX + radius;
            else if (m === back) position.z = b.minZ - radius;
            else position.z = b.maxZ + radius;
          }
          hit = true;
        }
      }
      if (!hit) break;
    }
    return position;
  }

  function blocks(x, z, radius) {
    for (const i of near(x, z)) {
      const b = boxes[i];
      const nx = Math.max(b.minX, Math.min(x, b.maxX));
      const nz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - nx;
      const dz = z - nz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  return { addBox, resolve, blocks, get count() { return boxes.length; } };
}
