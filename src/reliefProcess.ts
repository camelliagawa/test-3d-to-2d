import type { DepthMap } from "./depthCapture";

/** A normalised relief height field: values in [0,1] (taller = closer to the
 *  viewer), NaN for background pixels. */
export interface HeightField {
  data: Float32Array;
  width: number;
  height: number;
}

export interface ProcessOptions {
  /** Subtract the best-fit plane so the relief lies flat from any view angle. */
  removeTilt: boolean;
  /** 0 = keep overall volume, 1 = flatten the global form and boost detail
   *  (medallion / coin-style bas-relief). */
  detail: number;
  /** Contrast curve applied to the final height (>1 deepens). */
  gamma: number;
}

// Solve a 3x3 linear system (Gaussian elimination). Returns [x,y,z] or null.
function solve3(m: number[][], b: number[]): number[] | null {
  const a = m.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

// Separable box blur of value/weight buffers in place-ish (returns new arrays).
// Background (weight 0) contributes nothing, so edges don't bleed inward.
function boxBlur(val: Float32Array, wgt: Float32Array, w: number, h: number, r: number) {
  const tmpV = new Float32Array(val.length);
  const tmpW = new Float32Array(wgt.length);
  // Horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sv = 0, sw = 0;
    for (let x = 0; x <= r && x < w; x++) { sv += val[row + x]; sw += wgt[row + x]; }
    for (let x = 0; x < w; x++) {
      tmpV[row + x] = sv; tmpW[row + x] = sw;
      const add = x + r + 1, rem = x - r;
      if (add < w) { sv += val[row + add]; sw += wgt[row + add]; }
      if (rem >= 0) { sv -= val[row + rem]; sw -= wgt[row + rem]; }
    }
  }
  // Vertical
  for (let x = 0; x < w; x++) {
    let sv = 0, sw = 0;
    for (let y = 0; y <= r && y < h; y++) { sv += tmpV[y * w + x]; sw += tmpW[y * w + x]; }
    for (let y = 0; y < h; y++) {
      val[y * w + x] = sv; wgt[y * w + x] = sw;
      const add = y + r + 1, rem = y - r;
      if (add < h) { sv += tmpV[add * w + x]; sw += tmpW[add * w + x]; }
      if (rem >= 0) { sv -= tmpV[rem * w + x]; sw -= tmpW[rem * w + x]; }
    }
  }
}

/**
 * Turn a captured depth map into a bas-relief height field. Removes the global
 * tilt (so oblique views don't produce a slanted slab) and compresses the
 * low-frequency form while preserving high-frequency surface detail.
 */
export function depthToHeight(depth: DepthMap, opts: ProcessOptions): HeightField {
  const { data, width: w, height: h } = depth;
  const N = w * h;

  // Height proxy: nearer surface (smaller distance) should be taller.
  const m = new Float32Array(N);
  const valid = new Uint8Array(N);
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(data[i])) { m[i] = -data[i]; valid[i] = 1; count++; }
  }
  if (count === 0) throw new Error("深度マップに有効な面が見つかりませんでした。");

  // 1) Remove the best-fit plane (a*x + b*y + c) over valid pixels.
  if (opts.removeTilt) {
    let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, Sxm = 0, Sym = 0, Sm = 0;
    for (let i = 0; i < N; i++) {
      if (!valid[i]) continue;
      const x = i % w, y = (i / w) | 0, v = m[i];
      Sxx += x * x; Sxy += x * y; Sx += x; Syy += y * y; Sy += y;
      Sxm += x * v; Sym += y * v; Sm += v;
    }
    const sol = solve3([[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, count]], [Sxm, Sym, Sm]);
    if (sol) {
      const [a, b, c] = sol;
      for (let i = 0; i < N; i++) {
        if (valid[i]) m[i] -= a * (i % w) + b * ((i / w) | 0) + c;
      }
    }
  }

  // 2) Split into low (global form) and high (detail) frequency bands.
  const t = Math.min(1, Math.max(0, opts.detail));
  if (t > 0.001) {
    const val = new Float32Array(N);
    const wgt = new Float32Array(N);
    for (let i = 0; i < N; i++) { if (valid[i]) { val[i] = m[i]; wgt[i] = 1; } }
    const r = Math.max(1, Math.round(Math.min(w, h) * 0.12));
    boxBlur(val, wgt, w, h, r);
    boxBlur(val, wgt, w, h, r); // second pass ~ Gaussian

    const formWeight = 1 - 0.9 * t; // compress overall volume
    const detailGain = 1 + 5 * t;   // emphasise surface detail
    for (let i = 0; i < N; i++) {
      if (!valid[i]) continue;
      const low = wgt[i] > 0 ? val[i] / wgt[i] : m[i];
      const high = m[i] - low;
      m[i] = low * formWeight + high * detailGain;
    }
  }

  // 3) Normalise to [0,1] over valid pixels, apply gamma; background -> NaN.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) { if (valid[i]) { if (m[i] < lo) lo = m[i]; if (m[i] > hi) hi = m[i]; } }
  const span = Math.max(1e-6, hi - lo);
  const g = Math.max(0.05, opts.gamma);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = valid[i] ? Math.pow((m[i] - lo) / span, g) : NaN;
  }
  return { data: out, width: w, height: h };
}
