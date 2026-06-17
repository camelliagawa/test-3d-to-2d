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

const BG_SENTINEL = 1e9;

// Material that writes the positive view-space depth (distance from camera
// along the view axis) into the red channel of a float render target.
function makeDepthMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z; // positive = farther from camera
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vDepth;
      void main() {
        gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0);
      }
    `,
  });
}

/**
 * Render an orthographic depth map of `mesh` looking along the forward axis of
 * `viewCamera`. The orthographic frustum is fit tightly to the model's bounding
 * box as seen from that direction, so the capture matches what the user framed.
 */
export function captureDepth(
  renderer: THREE.WebGLRenderer,
  mesh: THREE.Mesh,
  viewCamera: THREE.Camera,
  maxResolution: number
): DepthMap {
  // Bounding box of the model in world space.
  const geom = mesh.geometry;
  geom.computeBoundingBox();
  const bbox = geom.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
  const center = bbox.getCenter(new THREE.Vector3());
  const sphere = bbox.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius;

  // View direction = the direction the user's camera is looking.
  const dir = new THREE.Vector3();
  viewCamera.getWorldDirection(dir).normalize();

  // Orthographic camera aimed along `dir`, placed outside the bounding sphere.
  const cam = new THREE.OrthographicCamera();
  cam.position.copy(center).addScaledVector(dir, -(radius + 1));
  cam.quaternion.copy(viewCamera.quaternion);
  cam.updateMatrixWorld(true);

  // Project the 8 bbox corners into the camera's view space to find a tight
  // frustum (extents in right/up and near/far along the view axis).
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

  const worldWidth = maxX - minX;
  const worldHeight = maxY - minY;

  cam.left = minX; cam.right = maxX;
  cam.bottom = minY; cam.top = maxY;
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

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });

  const depthMat = makeDepthMaterial();
  const prevMat = mesh.material;
  const prevBg = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevTarget = renderer.getRenderTarget();

  mesh.material = depthMat;
  renderer.setRenderTarget(target);
  renderer.setClearColor(new THREE.Color(BG_SENTINEL, 0, 0), 1);
  renderer.clear();
  renderer.render(mesh, cam);

  const rgba = new Float32Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, rgba);

  // Restore renderer / mesh state.
  mesh.material = prevMat;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevBg, prevAlpha);
  depthMat.dispose();
  target.dispose();

  const data = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const v = rgba[i * 4];
    data[i] = v >= BG_SENTINEL * 0.5 ? Infinity : v;
  }

  return { data, width, height, worldWidth, worldHeight };
}
