// Headless sanity check for buildRelief: feeds a synthetic depth map and
// verifies the resulting mesh is non-empty and watertight (every edge is
// shared by exactly two triangles). Run: node --experimental-strip-types scripts/test-relief.ts
import { buildRelief } from "../src/reliefBuilder.ts";
import type { DepthMap } from "../src/depthCapture.ts";

function makeDome(w: number, h: number, withBackground: boolean): DepthMap {
  const data = new Float32Array(w * h);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const r = Math.min(w, h) * 0.4;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const dist = Math.hypot(i - cx, j - cy);
      if (withBackground && dist > r) {
        data[j * w + i] = Infinity; // background
      } else {
        // dome: nearer (smaller depth) at center
        const t = Math.min(1, dist / r);
        data[j * w + i] = 10 + 5 * t * t;
      }
    }
  return { data, width: w, height: h, worldWidth: w, worldHeight: h };
}

function checkWatertight(geom: any, label: string) {
  const pos = geom.getAttribute("position");
  const idx = geom.getIndex();
  const triCount = idx.count / 3;
  const edges = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < triCount; t++) {
    const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const k = key(u, v);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const count of edges.values()) {
    if (count === 1) boundary++;
    else if (count > 2) nonManifold++;
  }
  const ok = boundary === 0 && nonManifold === 0 && triCount > 0;
  console.log(
    `[${label}] verts=${pos.count} tris=${triCount} ` +
      `boundaryEdges=${boundary} nonManifoldEdges=${nonManifold} -> ${ok ? "WATERTIGHT ✓" : "NOT closed ✗"}`
  );
  return ok;
}

const opts = { planeWidthMm: 60, reliefDepthMm: 8, baseThicknessMm: 2, gamma: 1.0, mode: "plate" as const };

let allOk = true;
allOk = checkWatertight(buildRelief(makeDome(40, 40, false), opts), "plate / no bg") && allOk;
allOk = checkWatertight(buildRelief(makeDome(48, 32, true), { ...opts, mode: "silhouette" }), "silhouette") && allOk;
allOk = checkWatertight(buildRelief(makeDome(40, 40, true), opts), "plate / with bg") && allOk;

if (!allOk) {
  console.error("FAILED: mesh is not watertight");
  process.exit(1);
}
console.log("All relief meshes are watertight.");
