import * as THREE from "three";

/**
 * Result of capturing a depth map of a mesh from a chosen viewing direction.
 * `data` holds the view-space distance (in model/world units) of the nearest
 * surface for each pixel, row-major, origin at bottom-left (WebGL convention).
 * Background pixels (no surface hit) are set to `Infinity`.
 */
export interface DepthMap {
  data: Float32Array;
  width: number;
  height: number;
  /** Width of the captured area in world units (model space). */
  worldWidth: number;
  /** Height of the captured area in world units (model space). */
  worldHeight: number;
}

// Depth material. When `float` is true it writes the raw view-space distance
// into the red channel (full float precision). Otherwise it encodes the
// distance, normalised to [0,1] over [near, far], into 16 bits across the R and
// G channels of an 8-bit target (fallback for GPUs without float-RT readback,
// e.g. some iOS devices). Alpha = 1 marks a hit; the target is cleared with
// alpha = 0 so background pixels are distinguishable.
function makeDepthMaterial(float: boolean, near: number, far: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uNear: { value: near }, uFar: { value: far } },
    vertexShader: /* glsl */ `
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z; // positive = farther from camera
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: float
      ? /* glsl */ `
        varying float vDepth;
        void main() {
          gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0);
        }
      `
      : /* glsl */ `
        varying float vDepth;
        uniform float uNear;
        uniform float uFar;
        void main() {
          float n = clamp((vDepth - uNear) / (uFar - uNear), 0.0, 1.0);
          float x = n * 65535.0;
          float hi = floor(x / 256.0);
          float lo = x - hi * 256.0;
          gl_FragColor = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
        }
      `,
  });
  // Keep the encoded values intact: no tone mapping or colour-space curve.
  mat.toneMapped = false;
  return mat;
}

/**
 * Render an orthographic depth map of `mesh` looking along the forward axis of
 * `viewCamera`. The orthographic frustum is fit tightly to the model's bounding
 * box as seen from that direction, so the capture matches what the user framed.
 */
export function captureDepth(
  renderer: THREE.WebGLRenderer,
  mesh: THREE.Mesh,
  viewCamera: THREE.PerspectiveCamera,
  maxResolution: number,
  fitTarget?: THREE.Vector3
): DepthMap {
  // Bounding box of the model in world space.
  const geom = mesh.geometry;
  geom.computeBoundingBox();
  const bbox = geom.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
  const bboxCenter = bbox.getCenter(new THREE.Vector3());
  const sphere = bbox.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius;

  // View direction = the direction the user's camera is looking.
  const dir = new THREE.Vector3();
  viewCamera.getWorldDirection(dir).normalize();

  // Orthographic camera aimed along `dir`. When `fitTarget` is given we centre
  // on it (so the on-screen framing/zoom is respected); otherwise on the model.
  const center = fitTarget ? fitTarget.clone() : bboxCenter;
  const cam = new THREE.OrthographicCamera();
  cam.position.copy(center).addScaledVector(dir, -(radius * 2 + 1));
  cam.quaternion.copy(viewCamera.quaternion);
  cam.updateMatrixWorld(true);

  // Project the 8 bbox corners into the camera's view space to find near/far
  // (and, for the full-model fit, the right/up extents).
  const view = cam.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  const corner = new THREE.Vector3();
  for (let xi = 0; xi < 2; xi++)
    for (let yi = 0; yi < 2; yi++)
      for (let zi = 0; zi < 2; zi++) {
        corner.set(
          xi ? bbox.max.x : bbox.min.x,
          yi ? bbox.max.y : bbox.min.y,
          zi ? bbox.max.z : bbox.min.z
        ).applyMatrix4(view);
        minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
        minZ = Math.min(minZ, corner.z); maxZ = Math.max(maxZ, corner.z);
      }

  let left: number, right: number, bottom: number, top: number;
  if (fitTarget) {
    // Match the perspective camera's on-screen rectangle at the target plane,
    // centred on the target (which projects to camera-space origin).
    const dist = viewCamera.position.distanceTo(fitTarget);
    const halfH = Math.tan(THREE.MathUtils.degToRad(viewCamera.fov) / 2) * dist;
    const halfW = halfH * viewCamera.aspect;
    left = -halfW; right = halfW; bottom = -halfH; top = halfH;
  } else {
    left = minX; right = maxX; bottom = minY; top = maxY;
  }

  const worldWidth = right - left;
  const worldHeight = top - bottom;

  cam.left = left; cam.right = right;
  cam.bottom = bottom; cam.top = top;
  // View-space z is negative in front of the camera; near/far are positive.
  cam.near = Math.max(0.001, -maxZ - 1);
  cam.far = -minZ + 1;
  cam.updateProjectionMatrix();

  // Pixel grid with square pixels in model space; longest side = maxResolution.
  const aspect = worldWidth / worldHeight;
  let width: number, height: number;
  if (aspect >= 1) {
    width = maxResolution;
    height = Math.max(2, Math.round(maxResolution / aspect));
  } else {
    height = maxResolution;
    width = Math.max(2, Math.round(maxResolution * aspect));
  }

  // Prefer a float render target for smooth depth; fall back to 16-bit packing
  // into an 8-bit target where float-RT readback is unavailable (e.g. iOS).
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const useFloat = isWebGL2 && !!gl.getExtension("EXT_color_buffer_float");

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: useFloat ? THREE.FloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
  // Store raw values without any colour-space conversion on write.
  target.texture.colorSpace = THREE.NoColorSpace;

  const depthMat = makeDepthMaterial(useFloat, cam.near, cam.far);
  const prevMat = mesh.material;
  const prevBg = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevTarget = renderer.getRenderTarget();
  const prevToneMapping = renderer.toneMapping;

  renderer.toneMapping = THREE.NoToneMapping;
  mesh.material = depthMat;
  renderer.setRenderTarget(target);
  renderer.setClearColor(new THREE.Color(0, 0, 0), 0);
  renderer.clear();
  renderer.render(mesh, cam);

  const data = new Float32Array(width * height);
  const range = cam.far - cam.near;

  if (useFloat) {
    const buf = new Float32Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, buf);
    for (let i = 0; i < width * height; i++) {
      data[i] = buf[i * 4 + 3] < 0.5 ? Infinity : buf[i * 4];
    }
  } else {
    const buf = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, buf);
    for (let i = 0; i < width * height; i++) {
      if (buf[i * 4 + 3] < 128) {
        data[i] = Infinity;
      } else {
        const n = (buf[i * 4] * 256 + buf[i * 4 + 1]) / 65535;
        data[i] = cam.near + n * range;
      }
    }
  }

  // Restore renderer / mesh state.
  mesh.material = prevMat;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevBg, prevAlpha);
  renderer.toneMapping = prevToneMapping;
  depthMat.dispose();
  target.dispose();

  return { data, width, height, worldWidth, worldHeight };
}
