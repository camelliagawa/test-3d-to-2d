import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { captureDepth, type DepthMap } from "./depthCapture";
import { buildRelief, type ShapeMode } from "./reliefBuilder";
import { depthToHeight } from "./reliefProcess";
import "./style.css";

// ---- DOM helpers ------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = $("viewport");
const dropzone = $("dropzone");
const fileInput = $<HTMLInputElement>("fileInput");
const captureBtn = $<HTMLButtonElement>("captureBtn");
const recaptureBtn = $<HTMLButtonElement>("recaptureBtn");
const exportBtn = $<HTMLButtonElement>("exportBtn");
const statusEl = $("status");

function setStatus(msg: string, kind: "" | "ok" | "err" = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}
function setActiveStep(n: number) {
  document.querySelectorAll<HTMLElement>(".step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) <= n);
  });
}

// ---- Three.js scene ---------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171b);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(0, 0, 200);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.4);
dir.position.set(1, 1, 1);
scene.add(dir);
const grid = new THREE.GridHelper(400, 20, 0x333a42, 0x262b32);
grid.rotation.x = Math.PI / 2; // lie in the XY plane
scene.add(grid);

const originalMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.7, metalness: 0.05 });
const reliefMat = new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.65, metalness: 0.02, flatShading: false });

let originalMesh: THREE.Mesh | null = null;
let reliefMesh: THREE.Mesh | null = null;
let lastDepth: DepthMap | null = null;
let modelRadius = 100;

// ---- Render loop ------------------------------------------------------------
function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
resize();
animate();

// ---- Model loading ----------------------------------------------------------
function loadSTL(buffer: ArrayBuffer) {
  const geom = new STLLoader().parse(buffer);
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  const center = bb.getCenter(new THREE.Vector3());
  geom.translate(-center.x, -center.y, -center.z); // center at origin
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  modelRadius = geom.boundingSphere!.radius;

  if (originalMesh) scene.remove(originalMesh);
  if (reliefMesh) { scene.remove(reliefMesh); reliefMesh.geometry.dispose(); reliefMesh = null; }
  lastDepth = null;

  originalMesh = new THREE.Mesh(geom, originalMat);
  scene.add(originalMesh);

  // Frame the camera.
  const dist = modelRadius / Math.sin((camera.fov / 2) * (Math.PI / 180));
  camera.position.set(0, 0, dist * 1.1);
  controls.target.set(0, 0, 0);
  camera.near = dist / 100;
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.update();
  grid.position.z = -modelRadius;

  dropzone.classList.add("loaded");
  captureBtn.disabled = false;
  recaptureBtn.disabled = true;
  exportBtn.disabled = true;
  ($("displayMode") as HTMLSelectElement).value = "original";
  setActiveStep(2);
  setStatus("角度を決めて「この角度でプレビュー生成」を押してください。");
}

function handleFile(file: File) {
  if (!/\.stl$/i.test(file.name)) {
    setStatus("STLファイルを指定してください。", "err");
    return;
  }
  setStatus(`読み込み中: ${file.name} …`);
  file.arrayBuffer().then((buf) => {
    try {
      loadSTL(buf);
    } catch (e) {
      console.error(e);
      setStatus("STLの読み込みに失敗しました。", "err");
    }
  });
}

// Drag & drop + click to choose.
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
});
["dragenter", "dragover"].forEach((ev) =>
  viewport.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("hover"); })
);
["dragleave", "drop"].forEach((ev) =>
  viewport.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("hover"); })
);
viewport.addEventListener("drop", (e: DragEvent) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// ---- Angle presets ----------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>(".preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const d = modelRadius / Math.sin((camera.fov / 2) * (Math.PI / 180)) * 1.1;
    const pos = { front: [0, 0, d], top: [0, d, 0.0001], side: [d, 0, 0] }[btn.dataset.view!]!;
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(0, 0, 0);
    controls.update();
  });
});

// ---- Relief options from UI -------------------------------------------------
function bindSlider(id: string, labelId: string) {
  const el = $<HTMLInputElement>(id);
  const lab = $(labelId);
  const sync = () => { lab.textContent = el.value; };
  el.addEventListener("input", () => { sync(); onParamChange(id); });
  sync();
}
bindSlider("detail", "detailVal");
bindSlider("planeW", "planeWVal");
bindSlider("reliefD", "reliefDVal");
bindSlider("baseT", "baseTVal");
bindSlider("res", "resVal");
bindSlider("gamma", "gammaVal");

function num(id: string) { return Number(($(id) as HTMLInputElement).value); }

function readProcessOptions() {
  return {
    removeTilt: ($("tiltMode") as HTMLSelectElement).value === "on",
    detail: num("detail") / 100,
    gamma: num("gamma"),
  };
}

function readGeometryOptions() {
  return {
    planeWidthMm: num("planeW"),
    reliefDepthMm: num("reliefD"),
    baseThicknessMm: num("baseT"),
    mode: ($("shapeMode") as HTMLSelectElement).value as ShapeMode,
  };
}

($("shapeMode") as HTMLSelectElement).addEventListener("change", () => rebuildRelief());
($("tiltMode") as HTMLSelectElement).addEventListener("change", () => rebuildRelief());
($("displayMode") as HTMLSelectElement).addEventListener("change", updateVisibility);

// Resolution change requires a fresh depth capture; other params just rebuild.
// Rebuilds are debounced so dragging a slider at high resolution stays smooth.
let rebuildTimer = 0;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(rebuildRelief, 140);
}
function onParamChange(id: string) {
  if (!lastDepth) return;
  if (id === "res") return; // recapture only on button press to avoid churn
  scheduleRebuild();
}

function updateVisibility() {
  const mode = ($("displayMode") as HTMLSelectElement).value;
  if (originalMesh) originalMesh.visible = mode === "original";
  if (reliefMesh) reliefMesh.visible = mode === "relief";
}

// ---- Capture + build --------------------------------------------------------
function captureAndBuild() {
  if (!originalMesh) return;
  scene.updateMatrixWorld(true);
  const res = Number(($("res") as HTMLInputElement).value);
  const fit = ($("fitMode") as HTMLSelectElement).value === "view"
    ? controls.target.clone()
    : undefined;
  try {
    setStatus("深度マップを生成中 …");
    lastDepth = captureDepth(renderer, originalMesh, camera, res, fit);
    rebuildRelief();
  } catch (e) {
    console.error(e);
    setStatus(String(e instanceof Error ? e.message : e), "err");
  }
}

// Switch back to the original model so the user can re-aim and regenerate.
function startRecapture() {
  if (!originalMesh) return;
  ($("displayMode") as HTMLSelectElement).value = "original";
  updateVisibility();
  setActiveStep(2);
  setStatus("モデルを回転・ズームして、もう一度「この角度でプレビュー生成」を押してください。");
}

function rebuildRelief() {
  if (!lastDepth) return;
  try {
    const field = depthToHeight(lastDepth, readProcessOptions());
    const geom = buildRelief(field, readGeometryOptions());
    if (reliefMesh) { scene.remove(reliefMesh); reliefMesh.geometry.dispose(); }
    reliefMesh = new THREE.Mesh(geom, reliefMat);
    // Lay the relief flat: back on the grid, front facing +Z.
    scene.add(reliefMesh);
    ($("displayMode") as HTMLSelectElement).value = "relief";
    updateVisibility();
    exportBtn.disabled = false;
    recaptureBtn.disabled = false;
    setActiveStep(4);
    const tri = (geom.getIndex()?.count ?? 0) / 3;
    setStatus(`プレビュー更新: 約 ${tri.toLocaleString()} 三角形`, "ok");
  } catch (e) {
    console.error(e);
    setStatus(String(e instanceof Error ? e.message : e), "err");
  }
}

captureBtn.addEventListener("click", captureAndBuild);
recaptureBtn.addEventListener("click", startRecapture);

// ---- Export -----------------------------------------------------------------
exportBtn.addEventListener("click", () => {
  if (!reliefMesh) return;
  const result = new STLExporter().parse(reliefMesh, { binary: true }) as unknown as DataView;
  const ab = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
  const blob = new Blob([ab], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "relief.stl";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("relief.stl を書き出しました。", "ok");
});

setActiveStep(1);
