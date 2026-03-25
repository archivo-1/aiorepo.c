// viewer-ifc.js

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { IFCLoader } from 'web-ifc-three/IFCLoader.js';

// ---------------------------------------------------------------------
// Escena básica
// ---------------------------------------------------------------------
const app = document.querySelector('#app');
const canvas = document.getElementById('three-canvas');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setClearColor(0x020617, 1);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020617);

// Cámaras
let orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera;
let orbitControls;
let cameraMode = 'orbit';
let isOrthoOrbit = false;
let is2DModel = false;

// Estado modelo
let ifcModel = null;
let modelGroup = new THREE.Group();
scene.add(modelGroup);
let groundMeshes = [];
let modelCenter = new THREE.Vector3();
let modelSize = new THREE.Vector3();
let modelSpan = 10;

// Raycaster / movimiento
const raycaster = new THREE.Raycaster();
const downVec = new THREE.Vector3(0, -1, 0);
const keys = {};
const velocity = new THREE.Vector3();
let yaw = 0,
  pitch = 0;
const WALK_HEIGHT = 1.7;

// Luces
let sun;

// ---------------------------------------------------------------------
// Materiales y estilos
// ---------------------------------------------------------------------
let visualStyle = 'rendered';
const meshMatCache = {};

const LAYER_OVERRIDES = {
  glass: {
    color: 0xadd8f7,
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.35,
  },
  window: {
    color: 0xadd8f7,
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.35,
  },
  concrete: {
    color: 0xb0a898,
    roughness: 0.85,
    metalness: 0.0,
  },
};

function buildMatSet(hexColor, layerName) {
  const lname = (layerName || '').toLowerCase();
  let ovr = null;
  Object.keys(LAYER_OVERRIDES).forEach((k) => {
    if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k];
  });

  const rendParams = ovr
    ? Object.assign({ side: THREE.DoubleSide }, ovr)
    : {
        color: hexColor,
        roughness: 0.72,
        metalness: 0.05,
        side: THREE.DoubleSide,
      };

  rendParams.polygonOffset = true;
  rendParams.polygonOffsetFactor = 1;
  rendParams.polygonOffsetUnits = 1;

  return {
    rendered: new THREE.MeshStandardMaterial(rendParams),
    clay: new THREE.MeshStandardMaterial({
      color: 0xd4c5b0,
      roughness: 0.75,
      metalness: 0.0,
      side: THREE.DoubleSide,
    }),
    wireframe: new THREE.MeshStandardMaterial({
      color: hexColor,
      wireframe: true,
      side: THREE.DoubleSide,
    }),
    xray: new THREE.MeshStandardMaterial({
      color: hexColor,
      transparent: true,
      opacity: 0.18,
      roughness: 0.3,
      metalness: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  };
}

function applyStyle(style) {
  visualStyle = style;
  document
    .querySelectorAll('.style-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.style === style));

  if (!modelGroup) return;
  modelGroup.traverse((obj) => {
    if (obj.isMesh && meshMatCache[obj.uuid]) {
      obj.material =
        meshMatCache[obj.uuid][style] || meshMatCache[obj.uuid].rendered;
    }
  });
}
window.applyStyle = applyStyle;

// ---------------------------------------------------------------------
// Utilidades de URL / DirArc
// ---------------------------------------------------------------------
function getQueryParam(name) {
  const p = new URLSearchParams(window.location.search);
  return p.get(name);
}

function getIdFromQuery() {
  return getQueryParam('id');
}

async function loadContent() {
  const slugDirArc = getQueryParam('slugDirArc');
  let url;
  if (slugDirArc) {
    url = `https://zihojlqhxfxdjahgrbwy.functions.supabase.co/dirarc-json?slug=${encodeURIComponent(
      slugDirArc
    )}`;
  } else {
    url = 'content.json';
  }
  const res = await fetch(url, { cache: 'no-cache' });
  const data = await res.json();
  const items = Array.isArray(data) ? data : data.items || [];
  return items;
}

function buildModelUrl(archivo) {
  if (/^https?:\/\//i.test(archivo)) return archivo;
  return archivo;
}

// ---------------------------------------------------------------------
// Planos de corte
// ---------------------------------------------------------------------
let planeBottom = null;
let planeTop = null;
let planeLeft = null;
let planeRight = null;
let planeFront = null;
let planeBack = null;
let clippingEnabled = true;

function setupClippingPlanes(box) {
  const min = box.min;
  const max = box.max;

  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(1, 0, 0);
  const forward = new THREE.Vector3(0, 0, 1);

  planeBottom = new THREE.Plane(up.clone(), -min.y);
  planeBottom._minY = min.y;
  planeBottom._maxY = max.y;

  planeTop = new THREE.Plane(up.clone().negate(), max.y);
  planeTop._minY = min.y;
  planeTop._maxY = max.y;

  planeLeft = new THREE.Plane(right.clone(), -min.x);
  planeLeft._minX = min.x;
  planeLeft._maxX = max.x;

  planeRight = new THREE.Plane(right.clone().negate(), max.x);
  planeRight._minX = min.x;
  planeRight._maxX = max.x;

  planeFront = new THREE.Plane(forward.clone(), -min.z);
  planeFront._minZ = min.z;
  planeFront._maxZ = max.z;

  planeBack = new THREE.Plane(forward.clone().negate(), max.z);
  planeBack._minZ = min.z;
  planeBack._maxZ = max.z;

  renderer.localClippingEnabled = true;
  updateClippingEnabled(clippingEnabled);
}

function updateCutBottom(percent) {
  if (!planeBottom) return;
  const minY = planeBottom._minY;
  const maxY = planeBottom._maxY;
  const y = minY + (maxY - minY) * (percent / 100);
  planeBottom.constant = -y;
}

function updateCutTop(percent) {
  if (!planeTop) return;
  const minY = planeTop._minY;
  const maxY = planeTop._maxY;
  const y = maxY - (maxY - minY) * (percent / 100);
  planeTop.constant = y;
}

function updateCutLeft(percent) {
  if (!planeLeft) return;
  const minX = planeLeft._minX;
  const maxX = planeLeft._maxX;
  const x = minX + (maxX - minX) * (percent / 100);
  planeLeft.constant = -x;
}

function updateCutRight(percent) {
  if (!planeRight) return;
  const minX = planeRight._minX;
  const maxX = planeRight._maxX;
  const x = maxX - (maxX - minX) * (percent / 100);
  planeRight.constant = x;
}

function updateCutFront(percent) {
  if (!planeFront) return;
  const minZ = planeFront._minZ;
  const maxZ = planeFront._maxZ;
  const z = minZ + (maxZ - minZ) * (percent / 100);
  planeFront.constant = -z;
}

function updateCutBack(percent) {
  if (!planeBack) return;
  const minZ = planeBack._minZ;
  const maxZ = planeBack._maxZ;
  const z = maxZ - (maxZ - minZ) * (percent / 100);
  planeBack.constant = z;
}

function updateClippingEnabled(enabled) {
  clippingEnabled = enabled;
  if (enabled) {
    const planes = [];
    if (planeBottom) planes.push(planeBottom);
    if (planeTop) planes.push(planeTop);
    if (planeLeft) planes.push(planeLeft);
    if (planeRight) planes.push(planeRight);
    if (planeFront) planes.push(planeFront);
    if (planeBack) planes.push(planeBack);
    renderer.clippingPlanes = planes;
  } else {
    renderer.clippingPlanes = [];
  }
}

// ---------------------------------------------------------------------
// Cámaras y modos
// ---------------------------------------------------------------------
function initCameras() {
  const aspect = window.innerWidth / window.innerHeight;

  orbitCamera = new THREE.PerspectiveCamera(60, aspect, 0.1, 5000);
  walkCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 500);
  flyCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 2000);
  orthoCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 5000);

  activeCamera = orbitCamera;

  orbitControls = new OrbitControls(orbitCamera, renderer.domElement);
  orbitControls.enableDamping = true;
}

function updateModeUI() {
  const labels = { orbit: 'Orbit', walk: 'Walk', fly: 'Fly', ortho: 'Top View' };
  const el = document.getElementById('mode-label');
  if (el) el.textContent = labels[cameraMode] || cameraMode;

  document.querySelectorAll('.cam-btn[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === cameraMode);
  });
}

function getGroundY(x, z) {
  if (groundMeshes.length === 0) return modelCenter.y;
  const origin = new THREE.Vector3(x, modelCenter.y + modelSpan * 5, z);
  raycaster.set(origin, downVec);
  const hits = raycaster.intersectObjects(groundMeshes, false);
  return hits.length > 0 ? hits[0].point.y : modelCenter.y;
}

function checkCollision(pos, radius) {
  if (groundMeshes.length === 0) return false;
  const dirs = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];

  for (let h of [0.5, WALK_HEIGHT, WALK_HEIGHT * 0.8]) {
    const p = pos.clone();
    p.y = pos.y - WALK_HEIGHT + h;
    for (let d of dirs) {
      raycaster.set(p, d);
      const hits = raycaster.intersectObjects(groundMeshes, false);
      if (hits.length > 0 && hits[0].distance < radius) return true;
    }
  }
  return false;
}

function syncOrthoCamera() {
  if (!orthoCamera) return;
  const aspect = window.innerWidth / window.innerHeight;
  const halfH = modelSpan * 0.7;
  const halfW = halfH * aspect;

  orthoCamera.left = -halfW;
  orthoCamera.right = halfW;
  orthoCamera.top = halfH;
  orthoCamera.bottom = -halfH;

  if (cameraMode === 'orbit' && isOrthoOrbit) {
    const dir = new THREE.Vector3()
      .subVectors(orbitCamera.position, orbitControls.target)
      .normalize();
    orthoCamera.position
      .copy(orbitControls.target)
      .addScaledVector(dir, modelSpan * 5);
    orthoCamera.lookAt(orbitControls.target);
  } else {
    orthoCamera.position.set(
      modelCenter.x,
      modelCenter.y + modelSpan * 5,
      modelCenter.z
    );
    orthoCamera.lookAt(modelCenter);
  }

  orthoCamera.updateProjectionMatrix();
}

function setCameraMode(mode) {
  if (is2DModel && mode !== 'ortho') return;

  const prev = cameraMode;
  cameraMode = mode;

  if ((prev === 'walk' || prev === 'fly') && document.pointerLockElement) {
    document.exitPointerLock();
  }

  if (mode === 'orbit') {
    activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
    orbitControls.object = activeCamera;
    orbitControls.enabled = true;
    orbitControls.enableRotate = true;
    orbitControls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
  } else if (mode === 'walk') {
    activeCamera = walkCamera;
    orbitControls.enabled = false;
    const target = orbitControls.target.clone();
    const groundY = getGroundY(target.x, target.z);
    walkCamera.position.set(
      target.x,
      groundY + WALK_HEIGHT,
      target.z + modelSpan * 0.05
    );
    walkCamera.rotation.set(0, 0, 0, 'YXZ');
    yaw = 0;
    pitch = 0;
  } else if (mode === 'fly') {
    activeCamera = flyCamera;
    orbitControls.enabled = false;
    flyCamera.position.copy(orbitCamera.position);
    flyCamera.lookAt(orbitControls.target);
    yaw = flyCamera.rotation.y;
    pitch = flyCamera.rotation.x;
  } else if (mode === 'ortho') {
    activeCamera = orthoCamera;
    orbitControls.object = orthoCamera;
    orbitControls.enabled = true;
    orbitControls.enableRotate = false;
    orbitControls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    syncOrthoCamera();
  }

  velocity.set(0, 0, 0);
  updateModeUI();
  const ev = new CustomEvent('modchange', { detail: mode });
  document.dispatchEvent(ev);
}

document.addEventListener('modchange', function (e) {
  const mode = e.detail;
  document.getElementById('orbit-controls').style.display =
    mode === 'orbit' ? '' : 'none';
  document.getElementById('walk-controls').style.display =
    mode === 'walk' ? '' : 'none';
  document.getElementById('fly-controls').style.display =
    mode === 'fly' ? '' : 'none';
  document.getElementById('ortho-controls').style.display =
    mode === 'ortho' ? '' : 'none';

  const hint = document.getElementById('lock-hint');
  if (hint) {
    hint.classList.toggle('visible', mode === 'walk' || mode === 'fly');
  }
});

function toggleOrtho() {
  isOrthoOrbit = !isOrthoOrbit;
  const btn = document.getElementById('ortho-toggle');
  if (btn) btn.classList.toggle('active', isOrthoOrbit);

  if (cameraMode === 'orbit') {
    activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
    if (isOrthoOrbit) syncOrthoCamera();
    orbitControls.object = activeCamera;
    orbitControls.update();
  } else if (cameraMode === 'ortho') {
    cameraMode = 'orbit';
    updateModeUI();
  }
}

function resetCamera() {
  if (!modelGroup) return;
  isOrthoOrbit = false;
  const btn = document.getElementById('ortho-toggle');
  if (btn) btn.classList.remove('active');

  const d = modelSpan;
  orbitCamera.position.set(
    modelCenter.x + d * 1.4,
    modelCenter.y + d * 1.2,
    modelCenter.z + d * 1.4
  );
  orbitControls.target.copy(modelCenter);
  activeCamera = orbitCamera;
  orbitControls.object = activeCamera;
  orbitControls.update();

  if (cameraMode === 'ortho') syncOrthoCamera();
}
window.resetCamera = resetCamera;

// ---------------------------------------------------------------------
// Luces
// ---------------------------------------------------------------------
function initLights() {
  sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(20, 40, 20);
  sun.castShadow = true;
  scene.add(sun);

  const amb = new THREE.AmbientLight(0x888899, 0.4);
  scene.add(amb);

  const grid = new THREE.GridHelper(50, 50, 0x4b5563, 0x1f2937);
  scene.add(grid);
}

function changeBackground(type) {
  if (!scene) return;
  if (type === 'black') {
    scene.background = new THREE.Color(0x050608);
    renderer.setClearColor(0x050608, 1);
  } else if (type === 'grey') {
    scene.background = new THREE.Color(0x111827);
    renderer.setClearColor(0x111827, 1);
  } else if (type === 'gradient') {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#020617');
    grad.addColorStop(1, '#111827');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 512);
    const tex = new THREE.CanvasTexture(canvas);
    scene.background = tex;
    renderer.setClearColor(0x000000, 1);
  }
}

function toggleShadows(enabled) {
  if (!renderer || !sun) return;
  renderer.shadowMap.enabled = enabled;
  sun.castShadow = enabled;
  if (modelGroup) {
    modelGroup.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = enabled;
        obj.receiveShadow = enabled;
      }
    });
  }
}

function updateSunFromUI() {
  if (!sun) return;
  const azEl = document.getElementById('sun-az');
  const elEl = document.getElementById('sun-el');
  if (!azEl || !elEl) return;

  const az = parseFloat(azEl.value);
  const el = parseFloat(elEl.value);

  const phi = (90 - el) * (Math.PI / 180);
  const theta = (az + 180) * (Math.PI / 180);
  const dist = modelSpan * 2.5;

  sun.position.set(
    modelCenter.x + dist * Math.sin(phi) * Math.cos(theta),
    modelCenter.y + dist * Math.cos(phi),
    modelCenter.z + dist * Math.sin(phi) * Math.sin(theta)
  );
  sun.target.position.copy(modelCenter);
  sun.target.updateMatrixWorld();
}

// ---------------------------------------------------------------------
// Loader IFC
// ---------------------------------------------------------------------
const ifcLoader = new IFCLoader();
ifcLoader.ifcManager.setWasmPath('https://unpkg.com/web-ifc@0.0.56/');

const helpOverlay = document.getElementById('help-overlay');
const helpText = helpOverlay ? helpOverlay.querySelector('p') : null;
if (helpText) helpText.textContent = 'Cargando modelo IFC...';

const loadingOverlay = document.getElementById('loading');
if (loadingOverlay) loadingOverlay.classList.remove('hidden');

// ---------------------------------------------------------------------
// Panel colección (pasa slugDirArc)
// ---------------------------------------------------------------------
function setupCollectionSideNav(allData, currentItem) {
  const collName = currentItem.coleccion || currentItem.collection;
  if (!collName) return;

  const siblings = allData.filter(
    (i) => i.coleccion === collName || i.collection === collName
  );
  if (siblings.length <= 1) return;

  const container = document.getElementById('collection-nav');
  if (!container) return;

  container.style.display = 'flex';
  const nameLabel = document.getElementById('collNameLabel');
  if (nameLabel) nameLabel.textContent = collName;

  const itemList = document.getElementById('collItemList');
  if (!itemList) return;

  const slugDirArc = getQueryParam('slugDirArc');
  const extra = slugDirArc ? `&slugDirArc=${encodeURIComponent(slugDirArc)}` : '';

  itemList.innerHTML = siblings
    .map((i) => {
      const visorType = i.visor || 'media';
      const url = `viewer-${visorType}.html?id=${encodeURIComponent(
        i.id
      )}${extra}`;
      return `<a href="${url}" class="coll-item ${
        i.id === currentItem.id ? 'active' : ''
      }">
        ${i.nombre || i.titulo || i.id}
    </a>`;
    })
    .join('');

  const tab = document.getElementById('collTab');
  tab?.addEventListener('click', (e) => {
    e.stopPropagation();
    container.classList.toggle('open');
  });

  document.addEventListener('pointerdown', (e) => {
    if (!container.contains(e.target) && container.classList.contains('open')) {
      container.classList.remove('open');
    }
  });
}

// ---------------------------------------------------------------------
// Panel capas IFC (placeholder honesto)
// ---------------------------------------------------------------------
function buildIfcLayersPanel() {
  const list = document.getElementById('layers-list');
  if (!list) return;

  list.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'layers-empty';
  span.textContent =
    'Control por tipos IFC en desarrollo. Use los cortes para explorar el interior.';
  list.appendChild(span);
}

// ---------------------------------------------------------------------
// Carga principal IFC
// ---------------------------------------------------------------------
async function initIfcFromContent() {
  try {
    const id = getIdFromQuery();
    if (!id) {
      if (helpText)
        helpText.textContent = 'No hay id en la URL (?id=...)';
      return;
    }

    const items = await loadContent();
    const item = items.find((it) => it.id === id);

    if (!item) {
      if (helpText)
        helpText.textContent =
          'Elemento no encontrado en contenido (id: ' + id + ')';
      return;
    }

    const titleEl = document.getElementById('model-title');
    if (titleEl) {
      titleEl.textContent = item.nombre || item.titulo || item.id;
    }

    setupCollectionSideNav(items, item);

    const archivo = item.archivo || '';
    const ext = archivo.split('.').pop().toLowerCase();
    if (ext !== 'ifc') {
      if (helpText)
        helpText.textContent =
          'El archivo no es IFC (extensión: ' + ext + ')';
      return;
    }

    const ifcUrl = buildModelUrl(archivo);

    ifcLoader.load(
      ifcUrl,
      async (model) => {
        ifcModel = model;
        modelGroup.add(ifcModel);

        ifcModel.traverse((obj) => {
          if (!obj.isMesh) return;
          const originalMat = obj.material;
          const hex =
            originalMat && originalMat.color && originalMat.color.getHex
              ? originalMat.color.getHex()
              : 0xcccccc;
          const set = buildMatSet(hex, '');
          set.rendered = originalMat;
          meshMatCache[obj.uuid] = set;
        });

        const box = new THREE.Box3().setFromObject(ifcModel);
        box.getSize(modelSize);
        box.getCenter(modelCenter);
        modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;

        setupClippingPlanes(box);

        const cutBottom = document.getElementById('cut-bottom');
        const cutTop = document.getElementById('cut-top');
        const cutLeft = document.getElementById('cut-left');
        const cutRight = document.getElementById('cut-right');
        const cutFront = document.getElementById('cut-front');
        const cutBack = document.getElementById('cut-back');
        const cutEnabled = document.getElementById('cut-enabled');

        if (cutBottom)
          updateCutBottom(parseFloat(cutBottom.value || '0'));
        if (cutTop) updateCutTop(parseFloat(cutTop.value || '0'));
        if (cutLeft) updateCutLeft(parseFloat(cutLeft.value || '0'));
        if (cutRight) updateCutRight(parseFloat(cutRight.value || '0'));
        if (cutFront)
          updateCutFront(parseFloat(cutFront.value || '0'));
        if (cutBack) updateCutBack(parseFloat(cutBack.value || '0'));
        updateClippingEnabled(cutEnabled ? cutEnabled.checked : true);

        resetCamera();
        updateSunFromUI();
        buildIfcLayersPanel();

        if (helpOverlay) helpOverlay.classList.add('hidden');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
      },
      undefined,
      (err) => {
        console.error('Error cargando IFC', err);
        if (helpText)
          helpText.textContent =
            'Error cargando IFC. Revisa la consola.';
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
      }
    );
  } catch (err) {
    console.error(err);
    if (helpText)
      helpText.textContent =
        'Error leyendo contenido. Revisa la consola.';
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------
// Controles UI
// ---------------------------------------------------------------------
function initUI() {
  document.querySelectorAll('.cam-btn').forEach((btn) => {
    const mode = btn.dataset.mode;
    if (!mode) return;

    if (btn.id === 'ortho-toggle') {
      btn.addEventListener('click', () => toggleOrtho());
      return;
    }
    if (mode === 'top') {
      btn.addEventListener('click', () => setCameraMode('ortho'));
      return;
    }

    btn.addEventListener('click', () => setCameraMode(mode));
  });

  document.querySelectorAll('.style-btn').forEach((btn) => {
    const style = btn.dataset.style;
    btn.addEventListener('click', () => applyStyle(style));
  });

  const layersPanel = document.getElementById('ifc-layers-panel');
  const layersToggle = document.getElementById('layers-toggle');
  if (layersPanel && layersToggle) {
    layersPanel.classList.add('collapsed');
    layersToggle.addEventListener('click', () => {
      layersPanel.classList.toggle('collapsed');
    });
  }

  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', resetCamera);

  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  const bgSelect = document.getElementById('bg-select');
  if (bgSelect) {
    bgSelect.addEventListener('change', (e) =>
      changeBackground(e.target.value)
    );
  }

  const shToggle = document.getElementById('shadows-toggle');
  if (shToggle) {
    shToggle.addEventListener('change', (e) =>
      toggleShadows(e.target.checked)
    );
  }

  const azInput = document.getElementById('sun-az');
  const elInput = document.getElementById('sun-el');
  if (azInput) azInput.addEventListener('input', updateSunFromUI);
  if (elInput) elInput.addEventListener('input', updateSunFromUI);

  const cutBottom = document.getElementById('cut-bottom');
  const cutTop = document.getElementById('cut-top');
  const cutLeft = document.getElementById('cut-left');
  const cutRight = document.getElementById('cut-right');
  const cutFront = document.getElementById('cut-front');
  const cutBack = document.getElementById('cut-back');
  const cutEnabled = document.getElementById('cut-enabled');

  if (cutBottom) {
    cutBottom.addEventListener('input', (e) =>
      updateCutBottom(parseFloat(e.target.value))
    );
  }
  if (cutTop) {
    cutTop.addEventListener('input', (e) =>
      updateCutTop(parseFloat(e.target.value))
    );
  }
  if (cutLeft) {
    cutLeft.addEventListener('input', (e) =>
      updateCutLeft(parseFloat(e.target.value))
    );
  }
  if (cutRight) {
    cutRight.addEventListener('input', (e) =>
      updateCutRight(parseFloat(e.target.value))
    );
  }
  if (cutFront) {
    cutFront.addEventListener('input', (e) =>
      updateCutFront(parseFloat(e.target.value))
    );
  }
  if (cutBack) {
    cutBack.addEventListener('input', (e) =>
      updateCutBack(parseFloat(e.target.value))
    );
  }
  if (cutEnabled) {
    cutEnabled.addEventListener('change', (e) =>
      updateClippingEnabled(e.target.checked)
    );
  }

  updateModeUI();
}

// ---------------------------------------------------------------------
// Animación / resize / input
// ---------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;

  orbitCamera.aspect = w / h;
  walkCamera.aspect = w / h;
  flyCamera.aspect = w / h;

  orbitCamera.updateProjectionMatrix();
  walkCamera.updateProjectionMatrix();
  flyCamera.updateProjectionMatrix();

  renderer.setSize(w, h);
});

window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});

function updateWalkFly(delta) {
  if (cameraMode !== 'walk' && cameraMode !== 'fly') return;

  const cam = activeCamera;
  const speed = cameraMode === 'walk' ? 5 : 15;

  const forward = new THREE.Vector3();
  cam.getWorldDirection(forward);
  forward.y = cameraMode === 'walk' ? 0 : forward.y;
  forward.normalize();

  const right = new THREE.Vector3().crossVectors(forward, cam.up).normalize();

  if (keys['KeyW']) velocity.addScaledVector(forward, speed * delta);
  if (keys['KeyS']) velocity.addScaledVector(forward, -speed * delta);
  if (keys['KeyA']) velocity.addScaledVector(right, -speed * delta);
  if (keys['KeyD']) velocity.addScaledVector(right, speed * delta);

  if (cameraMode === 'fly') {
    if (keys['Space']) velocity.y += speed * delta;
    if (keys['ShiftLeft']) velocity.y -= speed * delta;
  }

  velocity.multiplyScalar(0.92);

  const newPos = cam.position.clone().addScaledVector(velocity, delta);

  if (cameraMode === 'walk') {
    const groundY = getGroundY(newPos.x, newPos.z);
    newPos.y = groundY + WALK_HEIGHT;
  }

  if (!checkCollision(newPos, 0.5)) {
    cam.position.copy(newPos);
  }
}

let lastTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const delta = (now - lastTime) / 1000;
  lastTime = now;

  orbitControls.update();
  updateWalkFly(delta);

  renderer.render(scene, activeCamera);
}

// ---------------------------------------------------------------------
// Init general
// ---------------------------------------------------------------------
initCameras();
initLights();
initUI();
initIfcFromContent();
animate();
