import * as THREE from "three";
import type { DepthMap } from "./depthCapture";

export type ShapeMode = "silhouette" | "plate";

export interface ReliefOptions {
  /** Output width of the relief in millimetres (maps to the depth-map width). */
  planeWidthMm: number;
  /** Maximum relief height (front surface) in millimetres. */
  reliefDepthMm: number;
  /** Flat base/back thickness in millimetres. */
  baseThicknessMm: number;
  /** Depth emphasis exponent (gamma). >1 deepens, <1 flattens. */
  gamma: number;
  /** "silhouette" clips to the model outline, "plate" keeps a rectangular base. */
  mode: ShapeMode;
}

/**
 * Turn a depth map into a watertight relief mesh:
 *   front surface = height field (near = tall, far = low)
 *   back          = flat plane at z = 0
 *   side walls     = skirt closing the boundary
 *
 * The result is a manifold, closed solid suitable for 3D printing.
 */
export function buildRelief(depth: DepthMap, opts: ReliefOptions): THREE.BufferGeometry {
  const { data, width, height } = depth;
  const { planeWidthMm, reliefDepthMm, baseThicknessMm, gamma, mode } = opts;

  // Square pixels in model space.
  const dx = planeWidthMm / (width - 1);
  const planeHeightMm = dx * (height - 1);

  // Range of finite depths (background pixels are Infinity).
  let minD = Infinity;
  let maxD = -Infinity;
  for (let k = 0; k < data.length; k++) {
    const d = data[k];
    if (Number.isFinite(d)) {
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
  }
  if (!Number.isFinite(minD)) {
    throw new Error("深度マップに有効な面が見つかりませんでした。");
  }
  const span = Math.max(1e-6, maxD - minD);

  const px = (i: number) => i * dx - planeWidthMm / 2;
  const py = (j: number) => j * dx - planeHeightMm / 2;
  const idx = (i: number, j: number) => j * width + i;

  const finite = (i: number, j: number) => Number.isFinite(data[idx(i, j)]);

  // Front height (z) at a grid vertex, in mm.
  const frontZ = (i: number, j: number): number => {
    const d = data[idx(i, j)];
    if (!Number.isFinite(d)) return baseThicknessMm; // plate background = flat
    let h01 = (maxD - d) / span; // 0 (far) .. 1 (near)
    h01 = Math.pow(Math.min(1, Math.max(0, h01)), gamma);
    return baseThicknessMm + h01 * reliefDepthMm;
  };

  const positions: number[] = [];
  // Front vertices, then back vertices (parallel indexing).
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) positions.push(px(i), py(j), frontZ(i, j));
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) positions.push(px(i), py(j), 0);

  const N = width * height;
  const f = (i: number, j: number) => idx(i, j);
  const b = (i: number, j: number) => N + idx(i, j);

  const indices: number[] = [];
  const addTri = (a: number, bb: number, c: number) => indices.push(a, bb, c);

  const getPos = (vi: number, out: THREE.Vector3) =>
    out.set(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);

  // Cell (i,j) covers grid corners (i..i+1, j..j+1).
  const cellActive = (ci: number, cj: number): boolean => {
    if (ci < 0 || cj < 0 || ci >= width - 1 || cj >= height - 1) return false;
    if (mode === "plate") return true;
    return finite(ci, cj) && finite(ci + 1, cj) && finite(ci + 1, cj + 1) && finite(ci, cj + 1);
  };

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  // A wall quad along grid edge ga->gb, oriented to face `outward` (xy).
  const addWall = (gai: number, gaj: number, gbi: number, gbj: number, ox: number, oy: number) => {
    const fa = f(gai, gaj), fb = f(gbi, gbj);
    const ba = b(gai, gaj), bbk = b(gbi, gbj);
    // Candidate winding: fa, fb, bb, ba -> tris (fa,fb,bb),(fa,bb,ba)
    getPos(fa, va); getPos(fb, vb); getPos(bbk, vc);
    e1.subVectors(vb, va); e2.subVectors(vc, va); nrm.crossVectors(e1, e2);
    if (nrm.x * ox + nrm.y * oy >= 0) {
      addTri(fa, fb, bbk); addTri(fa, bbk, ba);
    } else {
      addTri(fa, bbk, fb); addTri(fa, ba, bbk);
    }
  };

  for (let cj = 0; cj < height - 1; cj++) {
    for (let ci = 0; ci < width - 1; ci++) {
      if (!cellActive(ci, cj)) continue;

      // Front face (normal +z).
      addTri(f(ci, cj), f(ci + 1, cj), f(ci + 1, cj + 1));
      addTri(f(ci, cj), f(ci + 1, cj + 1), f(ci, cj + 1));
      // Back face (normal -z, reversed winding).
      addTri(b(ci, cj), b(ci + 1, cj + 1), b(ci + 1, cj));
      addTri(b(ci, cj), b(ci, cj + 1), b(ci + 1, cj + 1));

      // Walls on edges that border an inactive cell or the grid edge.
      if (!cellActive(ci, cj - 1)) addWall(ci, cj, ci + 1, cj, 0, -1);       // bottom
      if (!cellActive(ci + 1, cj)) addWall(ci + 1, cj, ci + 1, cj + 1, 1, 0); // right
      if (!cellActive(ci, cj + 1)) addWall(ci + 1, cj + 1, ci, cj + 1, 0, 1); // top
      if (!cellActive(ci - 1, cj)) addWall(ci, cj + 1, ci, cj, -1, 0);        // left
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}
