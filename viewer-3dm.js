(function() {
    'use strict';

    // Toggle para diagnóstico Rhino en consola
    const DEBUG_RHINO = false;

    // ── Core scene objects ──────────────────────────────────────────────────
    let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
    let cameraMode = 'orbit';
    let isOrthoOrbit = false;
    let is2DModel = false;
    let modelGroup = null;
    let groundMeshes = [];
    let modelSize = new THREE.Vector3();
    let modelSpan = 10;
    const raycaster = new THREE.Raycaster();
    const downVec = new THREE.Vector3(0, -1, 0);
    const keys = {};
    const velocity = new THREE.Vector3();
    const damping = 0.85;
    let yaw = 0, pitch = 0;
    const WALK_HEIGHT = 1.7;

    // ── Layers state ────────────────────────────────────────────────────────
    let layerMeshes = {};

        // ── Aio Notes state ────────────────────────────────────────────────────
    let aioNotes = [];
    let hasAioNotes = false;
    let aioHotspotsGroup = null;
    let aioBillboardsGroup = null;
    let activeAioNoteIndex = -1;
    let cameraFocusAnim = null;
    let orthoFocusAnim = null;
    const _tmpVecA = new THREE.Vector3();
    const _tmpVecB = new THREE.Vector3();
    const _tmpVecC = new THREE.Vector3();



    // ── Visual style ────────────────────────────────────────────────────────
    let visualStyle = 'rendered';
    const meshMatCache = {};
    let sun, fill, sky, skyUniforms, modelCenter = new THREE.Vector3();
    const LAYER_OVERRIDES = {
        glass: { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
        window: { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
        water: { color: 0x1a6fa8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75 },
        ocean: { color: 0x1a6fa8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75 },
        terrain: { color: 0x8a7560, roughness: 0.9, metalness: 0.0 },
        ground: { color: 0x8a7560, roughness: 0.9, metalness: 0.0 },
        metal: { color: 0x888888, roughness: 0.3, metalness: 0.85 },
        steel: { color: 0x888888, roughness: 0.3, metalness: 0.85 },
        concrete: { color: 0xb0a898, roughness: 0.85, metalness: 0.0 }
    };

    // ── Helpers ─────────────────────────────────────────────────────────────
    function getModelFromQuery() {
        const p = new URLSearchParams(window.location.search);
        return p.get('id');
    }

    function getQueryParam(name) {
        const params = new URLSearchParams(window.location.search);
        return params.get(name);
    }

    function getLocalItems() {
        try {
            const raw = sessionStorage.getItem('archvista-local-items');
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            if (DEBUG_RHINO) console.warn('No se pudieron leer items locales:', e);
            return [];
        }
    }

    function requestLocalItemFromOpener(id) {
        return new Promise((resolve) => {
            try {
                if (!window.opener || window.opener.closed) {
                    resolve(null);
                    return;
                }

                const timeout = setTimeout(() => {
                    window.removeEventListener('message', onMessage);
                    resolve(null);
                }, 1200);

                function onMessage(event) {
                    const data = event.data || {};
                    if (data?.type !== 'ARCHVISTA_RESPONSE_LOCAL_ITEM') return;
                    if (data?.id !== id) return;

                    clearTimeout(timeout);
                    window.removeEventListener('message', onMessage);
                    resolve(data.item || null);
                }

                window.addEventListener('message', onMessage);

                window.opener.postMessage(
                    {
                        type: 'ARCHVISTA_REQUEST_LOCAL_ITEM',
                        id
                    },
                    '*'
                );
            } catch (err) {
                console.warn('No se pudo pedir item local al opener:', err);
                resolve(null);
            }
        });
    }

    function isLocalSource() {
        return getQueryParam('source') === 'local';
    }

    async function loadContent() {
        if (isLocalSource()) {
            const id = getModelFromQuery();

            const openerItem = id ? await requestLocalItemFromOpener(id) : null;
            if (openerItem) {
                return [openerItem];
            }

            return getLocalItems();
        }

        const slugDirArc = getQueryParam('slugDirArc');
        let url;

        if (slugDirArc) {
            url = `https://zihojlqhxfxdjahgrbwy.functions.supabase.co/dirarc-json?slug=${encodeURIComponent(slugDirArc)}`;
        } else {
            url = 'content.json';
        }

        const res = await fetch(url);
        const data = await res.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        return items;
    }

    function showLoading(msg) {
        const el = document.getElementById('loading');
        if (!el) return;
        el.classList.remove('hidden');
        const p = el.querySelector('p');
        if (p && msg) p.textContent = msg;
    }

    function hideLoading() {
        const el = document.getElementById('loading');
        if (el) el.classList.add('hidden');
    }

    // ── Audit helpers ───────────────────────────────────────────────────────
    function createRhinoAudit() {
        return {
            totalObjects: 0,
            convertedObjects: 0,
            meshObjects: 0,
            lineObjects: 0,
            instanceRefs: 0,
            unsupportedObjects: 0,
            emptyResults: 0,
            errors: 0,
            byCtor: {},
            byOutcome: {},
            byDepth: {}
        };
    }

    function auditInc(map, key, amount = 1) {
        if (!map) return;
        const k = key || 'unknown';
        map[k] = (map[k] || 0) + amount;
    }

    function getGeomCtorName(geom) {
        try {
            return geom?.constructor?.name || 'unknown';
        } catch (e) {
            return 'unknown';
        }
    }

    function getGeomObjectTypeLabel(geom) {
        try {
            const objectType = geom?.objectType;
            if (objectType == null) return 'null';

            if (typeof objectType === 'number' || typeof objectType === 'string') {
                return String(objectType);
            }

            if (typeof objectType.valueOf === 'function') {
                const v = objectType.valueOf();
                if (typeof v === 'number' || typeof v === 'string') {
                    return String(v);
                }
            }

            return Object.prototype.toString.call(objectType);
        } catch (e) {
            return 'unknown';
        }
    }

    function printRhinoAudit(audit, displayName = 'unknown') {
        if (!DEBUG_RHINO) return;
        console.groupCollapsed(`Aio Visor Audit: ${displayName}`);
        console.log('summary', {
            totalObjects: audit.totalObjects,
            convertedObjects: audit.convertedObjects,
            meshObjects: audit.meshObjects,
            lineObjects: audit.lineObjects,
            instanceRefs: audit.instanceRefs,
            unsupportedObjects: audit.unsupportedObjects,
            emptyResults: audit.emptyResults,
            errors: audit.errors
        });
        console.log('byCtor', audit.byCtor);
        console.log('byOutcome', audit.byOutcome);
        console.log('byDepth', audit.byDepth);
        console.groupEnd();
    }

    // ── Environment & Background ─────────────────────────────────────────────
    function initSky() {
        if (sky) return;

        sky = new THREE.Sky();
        sky.scale.setScalar(450000);
        scene.add(sky);

        skyUniforms = sky.material.uniforms;
        skyUniforms['turbidity'].value = 10;
        skyUniforms['rayleigh'].value = 3;
        skyUniforms['mieCoefficient'].value = 0.005;
        skyUniforms['mieDirectionalG'].value = 0.7;
    }

    function updateSun() {
        if (!sun) return;

        const az = parseFloat(document.getElementById('sun-az').value);
        const el = parseFloat(document.getElementById('sun-el').value);

        const azEl = document.getElementById('az-val');
        const elEl = document.getElementById('el-val');

        if (azEl) azEl.textContent = az + '°';
        if (elEl) elEl.textContent = el + '°';

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

        if (skyUniforms) skyUniforms['sunPosition'].value.copy(sun.position);

        const d = modelSpan * 1.5;
        sun.shadow.camera.left = -d;
        sun.shadow.camera.right = d;
        sun.shadow.camera.top = d;
        sun.shadow.camera.bottom = -d;
        sun.shadow.camera.updateProjectionMatrix();
    }

    function changeBackground(type) {
        if (!scene) return;

        if (sky) {
            scene.remove(sky);
            sky = null;
            skyUniforms = null;
        }

        if (type === 'black') {
            scene.background = new THREE.Color(0x050608);
        } else if (type === 'white') {
            scene.background = new THREE.Color(0xffffff);
        } else if (type === 'grey') {
            scene.background = new THREE.Color(0x22262e);
        } else if (type === 'sky' || type === 'sunset') {
            initSky();

            if (type === 'sunset') {
                document.getElementById('sun-el').value = 2;
                document.getElementById('sun-az').value = 180;
                skyUniforms['turbidity'].value = 20;
                skyUniforms['rayleigh'].value = 2;
            } else {
                skyUniforms['turbidity'].value = 10;
                skyUniforms['rayleigh'].value = 3;
            }

            updateSun();
            scene.background = null;
        } else if (type === 'gradient') {
            const canvas = document.createElement('canvas');
            canvas.width = 2;
            canvas.height = 512;

            const ctx = canvas.getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 512);

            grad.addColorStop(0, '#020617');
            grad.addColorStop(1, '#1e293b');

            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 2, 512);

            scene.background = new THREE.CanvasTexture(canvas);
        }
    }

    function toggleShadows(enabled) {
        if (!renderer || !sun) return;

        sun.castShadow = enabled;

        if (modelGroup) {
            modelGroup.traverse(function(obj) {
                if (obj.isMesh) {
                    obj.castShadow = obj.receiveShadow = enabled;
                }
            });
        }
    }

    // ── Camera mode UI ───────────────────────────────────────────────────────
        function updateModeUI() {
        const labels = {
            orbit: 'Orbit',
            walk: 'Walk',
            fly: 'Fly',
            ortho: 'Top View',
            notes: 'Aio Notes'
        };

        const el = document.getElementById('mode-label');
        if (el) el.textContent = labels[cameraMode] || cameraMode;

        document.querySelectorAll('.cam-btn[data-mode]').forEach(function(b) {
            b.classList.toggle('active', b.dataset.mode === cameraMode);
        });

        document.dispatchEvent(new CustomEvent('modchange', { detail: cameraMode }));
    }

       function setCameraMode(mode) {
    if (mode === 'notes' && !hasAioNotes) return;
    if (is2DModel && mode !== 'ortho' && mode !== 'notes') return;

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
    orbitControls.enablePan = true;
    orbitControls.enableZoom = true;
    orbitControls.screenSpacePanning = false;
    unlockOrbitRotationLimits();

    orbitControls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
    };

    if (isOrthoOrbit) {
        syncOrthoCamera();
    }
    } else if (mode === 'notes') {
        if (is2DModel) {
            activeCamera = orthoCamera;
            syncOrthoCamera();
            lockTopViewControls(orbitControls ? orbitControls.target : modelCenter);
        } else {
            activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;

            orbitControls.object = activeCamera;
            orbitControls.enabled = true;
            orbitControls.enableRotate = true;
            orbitControls.enablePan = true;
            orbitControls.enableZoom = true;
            orbitControls.screenSpacePanning = false;
            unlockOrbitRotationLimits();

            orbitControls.mouseButtons = {
                LEFT: THREE.MOUSE.ROTATE,
                MIDDLE: THREE.MOUSE.DOLLY,
                RIGHT: THREE.MOUSE.PAN
            };

            if (isOrthoOrbit) {
                syncOrthoCamera();
            }
        }
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
        syncOrthoCamera();
        lockTopViewControls(orbitControls ? orbitControls.target : modelCenter);
    }

    velocity.set(0, 0, 0);
    updateAioHotspotsVisibility();
    updateScreenSizedSprites();
    if (mode !== 'notes') {
    cameraFocusAnim = null;
    orthoFocusAnim = null;
    }
    if (mode !== 'notes') {
    hideAioNoteCard();
    }
    updateModeUI();
}

   function toggleOrtho() {
    if (is2DModel) return;

    isOrthoOrbit = !isOrthoOrbit;

    const btn = document.getElementById('ortho-toggle');
    if (btn) btn.classList.toggle('active', isOrthoOrbit);

    if (cameraMode === 'orbit' || cameraMode === 'notes') {
        activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;

        if (isOrthoOrbit) {
            syncOrthoCamera();
        }

        orbitControls.object = activeCamera;
        orbitControls.enabled = true;
        orbitControls.enableRotate = true;
        orbitControls.enablePan = true;
        orbitControls.enableZoom = true;
        orbitControls.screenSpacePanning = false;
        unlockOrbitRotationLimits();

        orbitControls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN
        };

        orbitControls.update();
        updateScreenSizedSprites();
    }
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

    if (!is2DModel && isOrthoOrbit && cameraMode === 'orbit') {
        const dir = new THREE.Vector3()
            .subVectors(orbitCamera.position, orbitControls.target)
            .normalize();

        orthoCamera.position
            .copy(orbitControls.target)
            .addScaledVector(dir, modelSpan * 5);

        orthoCamera.lookAt(orbitControls.target);
    } else if (!is2DModel && isOrthoOrbit && cameraMode === 'notes') {
        const dir = new THREE.Vector3()
            .subVectors(orbitCamera.position, orbitControls.target)
            .normalize();

        orthoCamera.position
            .copy(orbitControls.target)
            .addScaledVector(dir, modelSpan * 5);

        orthoCamera.lookAt(orbitControls.target);
    } else {
        const target = orbitControls ? orbitControls.target.clone() : modelCenter.clone();
        const dist = Math.max(modelSpan * 5, 10);

        orthoCamera.up.set(0, 1, 0);
        orthoCamera.position.set(target.x, target.y + dist, target.z);
        orthoCamera.lookAt(target);
        orthoCamera.rotation.set(-Math.PI / 2, 0, 0);
    }

    orthoCamera.updateProjectionMatrix();
}

    function lockTopViewControls(targetPoint) {
    if (!orbitControls || !orthoCamera) return;

    const target = targetPoint ? targetPoint.clone() : modelCenter.clone();
    const dist = Math.max(modelSpan * 5, 10);

    orbitControls.object = orthoCamera;
    orbitControls.enabled = true;

    // Top 2D: pan libre, sin Shift
    orbitControls.enableRotate = false;
    orbitControls.enablePan = true;
    orbitControls.enableZoom = true;
    orbitControls.screenSpacePanning = true;

    orbitControls.minPolarAngle = 0;
    orbitControls.maxPolarAngle = 0;
    orbitControls.minAzimuthAngle = 0;
    orbitControls.maxAzimuthAngle = 0;

    orbitControls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
    };

    orbitControls.target.copy(target);

    orthoCamera.up.set(0, 1, 0);
    orthoCamera.position.set(target.x, target.y + dist, target.z);
    orthoCamera.lookAt(target);
    orthoCamera.rotation.set(-Math.PI / 2, 0, 0);

    orbitControls.update();
}

function unlockOrbitRotationLimits() {
    if (!orbitControls) return;

    orbitControls.minPolarAngle = 0;
    orbitControls.maxPolarAngle = Math.PI;
    orbitControls.minAzimuthAngle = -Infinity;
    orbitControls.maxAzimuthAngle = Infinity;
}



    function getGroundY(x, z) {
        if (groundMeshes.length === 0) return modelCenter.y;

        const origin = new THREE.Vector3(
            x,
            modelCenter.y + modelSpan * 5,
            z
        );

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
            new THREE.Vector3(0, 0, -1)
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

        if (cameraMode === 'ortho') {
            syncOrthoCamera();
        }
    }
    window.resetCamera = resetCamera;

    function buildMatSet(hexColor, layerName) {
        const lname = (layerName || '').toLowerCase();
        let ovr = null;

        Object.keys(LAYER_OVERRIDES).forEach(k => {
            if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k];
        });

        const rendParams = ovr
            ? Object.assign({ side: THREE.DoubleSide }, ovr)
            : {
                color: hexColor,
                roughness: 0.72,
                metalness: 0.05,
                side: THREE.DoubleSide
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
                side: THREE.DoubleSide
            }),
            wireframe: new THREE.MeshStandardMaterial({
                color: hexColor,
                wireframe: true,
                side: THREE.DoubleSide
            }),
            xray: new THREE.MeshStandardMaterial({
                color: hexColor,
                transparent: true,
                opacity: 0.18,
                roughness: 0.3,
                metalness: 0.0,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        };
    }

    function applyStyle(style) {
        visualStyle = style;

        document.querySelectorAll('.style-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.style === style);
        });

        if (!modelGroup) return;

        modelGroup.traverse(obj => {
            if (obj.isMesh && meshMatCache[obj.uuid]) {
                obj.material =
                    meshMatCache[obj.uuid][style] ||
                    meshMatCache[obj.uuid].rendered;
            }
        });
    }
    window.applyStyle = applyStyle;

    function updateLayersUI() {
        const list = document.getElementById('layers-list');
        if (!list) return;

        list.innerHTML = '';

        const names = Object.keys(layerMeshes).sort();

        if (names.length === 0) {
            list.innerHTML =
                '<div style="font-size:0.65rem;color:#6b7280;padding:0.2rem">No layers found</div>';
            return;
        }

        names.forEach(name => {
            const row = document.createElement('div');
            row.className = 'layer-row';

            const span = document.createElement('span');
            span.className = 'layer-name';
            span.textContent = name;

            const lbl = document.createElement('label');
            lbl.className = 'toggle-switch';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.onchange = () => {
                if (layerMeshes[name]) {
                    layerMeshes[name].forEach(m => (m.visible = cb.checked));
                }
            };

            const track = document.createElement('span');
            track.className = 'toggle-track';

            lbl.appendChild(cb);
            lbl.appendChild(track);

            row.appendChild(span);
            row.appendChild(lbl);

            list.appendChild(row);
        });
    }

    function getObjAppearance(obj, doc) {
        let hexColor = 0xcccccc;
        let layerName = 'Default';

        try {
            const attrs = obj.attributes();
            const layerIdx = attrs.layerIndex;
            const layers = doc.layers();

            if (layerIdx >= 0 && layers.count > 0) {
                const layer = layers.get(layerIdx);
                if (layer) {
                    layerName = layer.name || 'Default';

                    hexColor =
                        (attrs.colorSource === 1 ||
                            attrs.colorSource === 'object')
                            ? rhinoColorToHex(attrs.objectColor || attrs.drawColor)
                            : rhinoColorToHex(layer.color);
                }
            }
        } catch (e) {
            if (DEBUG_RHINO) console.warn('Aio Visor: error leyendo apariencia', e);
        }

        return { hexColor, layerName };
    }

    function rhinoColorToHex(rc) {
    if (!rc) return 0xcccccc;

    const r = rc.r !== undefined ? rc.r : (rc[0] || 0);
    const g = rc.g !== undefined ? rc.g : (rc[1] || 0);
    const b = rc.b !== undefined ? rc.b : (rc[2] || 0);

    // Tratar negro “pleno” como gris claro, similar a Shaded de Rhino
    if (r === 0 && g === 0 && b === 0) {
        return 0x777777; // o 0x888888 / 0x999999 según gusto
    }

    return (r << 16) | (g << 8) | b;
}


    function getUserStringValue(source, key) {
        if (!source || !key) return null;

        try {
            if (typeof source.getUserString === 'function') {
                const v = source.getUserString(key);
                if (v != null && String(v).trim() !== '') return String(v).trim();
            }
        } catch (e) {}

        try {
            if (typeof source.getUserStrings === 'function') {
                const all = source.getUserStrings();
                if (all && typeof all === 'object') {
                    const v = all[key];
                    if (v != null && String(v).trim() !== '') return String(v).trim();
                }
            }
        } catch (e) {}

        return null;
    }

    function parseAioNote(obj, geom) {
    if (!obj || !geom) return null;

    let attrs = null;
    try {
        attrs = obj.attributes ? obj.attributes() : null;
    } catch (e) {}

    const enabledRaw =
        getUserStringValue(attrs, 'AIO_NOTE') ||
        getUserStringValue(geom, 'AIO_NOTE');

    if (!enabledRaw) return null;

    const enabled = String(enabledRaw).toLowerCase();
    if (!(enabled === '1' || enabled === 'true' || enabled === 'yes')) return null;

    const title =
        getUserStringValue(attrs, 'AIO_TITLE') ||
        getUserStringValue(geom, 'AIO_TITLE');

    if (!title) return null;

    const body =
        getUserStringValue(attrs, 'AIO_BODY') ||
        getUserStringValue(geom, 'AIO_BODY') || '';

    const image =
        getUserStringValue(attrs, 'AIO_IMAGE') ||
        getUserStringValue(geom, 'AIO_IMAGE') || '';

    const category =
        getUserStringValue(attrs, 'AIO_CATEGORY') ||
        getUserStringValue(geom, 'AIO_CATEGORY') || '';

    const state =
        getUserStringValue(attrs, 'AIO_STATE') ||
        getUserStringValue(geom, 'AIO_STATE') || 'info';

    const orderRaw =
        getUserStringValue(attrs, 'AIO_ORDER') ||
        getUserStringValue(geom, 'AIO_ORDER');

    let order = null;
    if (orderRaw != null && orderRaw !== '') {
        const parsed = parseInt(orderRaw, 10);
        if (!Number.isNaN(parsed)) order = parsed;
    }

    // Nuevo: modo de display (ui / billboard / auto)
    const displayRaw =
        getUserStringValue(attrs, 'AIO_DISPLAY') ||
        getUserStringValue(geom, 'AIO_DISPLAY') || '';

    let displayMode = 'ui';
    if (displayRaw) {
        const d = String(displayRaw).toLowerCase().trim();
        if (d === 'billboard' || d === 'ui' || d === 'auto') {
            displayMode = d;
        }
    }

    let point = null;
    let noteType = 'object';

    try {
        const ctorName = getGeomCtorName(geom);
        if (geom.objectType === 1 || ctorName === 'Point') {
            const p = geom.location || geom.point || null;
            if (p) {
                point = new THREE.Vector3(p[0], p[1], p[2]);
                noteType = 'point';
            }
        }
    } catch (e) {}

    if (!point) {
        try {
            const bbox = geom.getBoundingBox ? geom.getBoundingBox() : null;
            if (bbox && bbox.min && bbox.max) {
                point = new THREE.Vector3(
                    (bbox.min[0] + bbox.max[0]) * 0.5,
                    (bbox.min[1] + bbox.max[1]) * 0.5,
                    (bbox.min[2] + bbox.max[2]) * 0.5
                );
            }
        } catch (e) {}
    }

    if (!point) return null;

    return {
        type: noteType,
        title,
        body,
        image,
        category,
        state,
        order,
        point,
        displayMode   // <- nuevo campo
    };
}

    function getAioStateColor(state) {
    const s = String(state || 'info').toLowerCase();
    if (s === 'warning') return { fill: '#f59e0b', stroke: '#ffffff', text: '#111827' };
    if (s === 'todo') return { fill: '#3b82f6', stroke: '#ffffff', text: '#ffffff' };
    if (s === 'approved') return { fill: '#10b981', stroke: '#ffffff', text: '#ffffff' };
    return { fill: '#111827', stroke: '#ffffff', text: '#ffffff' };
}

function getAioCardEls() {
    return {
        card: document.getElementById('aio-note-card'),
        state: document.getElementById('aio-note-state'),
        category: document.getElementById('aio-note-category'),
        index: document.getElementById('aio-note-index'),
        title: document.getElementById('aio-note-title'),
        text: document.getElementById('aio-note-text'),
        prev: document.getElementById('aio-note-prev'),
        next: document.getElementById('aio-note-next'),
        close: document.getElementById('aio-note-close')
    };
}

function hideAioNoteCard() {
    const els = getAioCardEls();
    if (!els.card) return;
    els.card.classList.add('hidden');
}

function showAioNoteCard(note, index) {
    const els = getAioCardEls();
    if (!els.card || !note) return;

    const total = aioNotes.length;
    const stateLabel = note.state || 'info';
    const categoryLabel = note.category || '';
    const colors = getAioStateColor(stateLabel);

    els.state.textContent = stateLabel;
    els.state.style.background = colors.fill === '#111827'
        ? 'rgba(255,255,255,0.08)'
        : hexToRgba(colors.fill, 0.22);
    els.state.style.borderColor = hexToRgba(colors.fill, 0.42);
    els.state.style.color = colors.fill === '#111827' ? '#e5e7eb' : colors.fill;

    els.category.textContent = categoryLabel;
    els.category.style.display = categoryLabel ? '' : 'none';

    els.index.textContent = `Nota ${index + 1} / ${total}`;
    els.title.textContent = note.title || 'Sin título';
    els.text.textContent = note.body || '';

    els.prev.disabled = total <= 1;
    els.next.disabled = total <= 1;

    els.card.classList.remove('hidden');
}

function hexToRgba(hex, alpha) {
    const safe = String(hex || '').replace('#', '');
    const full = safe.length === 3
        ? safe.split('').map(ch => ch + ch).join('')
        : safe.padStart(6, '0').slice(0, 6);

    const r = parseInt(full.slice(0, 2), 16) || 0;
    const g = parseInt(full.slice(2, 4), 16) || 0;
    const b = parseInt(full.slice(4, 6), 16) || 0;

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function makeAioHotspotTexture(note) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    const colors = getAioStateColor(note.state);

    const cx = size / 2;
    const cy = size / 2;
    const r = 34;

    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = colors.fill;
    ctx.fill();

    ctx.lineWidth = 6;
    ctx.strokeStyle = colors.stroke;
    ctx.stroke();

    const hasOrder = Number.isFinite(note.order);
    if (hasOrder) {
        ctx.fillStyle = colors.text;
        ctx.font = 'bold 44px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(note.order), cx, cy + 1);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
}

function disposeAioHotspots() {
    if (!aioHotspotsGroup) return;

    aioHotspotsGroup.traverse(obj => {
        if (obj.material) {
            if (obj.material.map) obj.material.map.dispose();
            obj.material.dispose();
        }
        if (obj.geometry) obj.geometry.dispose();
    });

    if (aioHotspotsGroup.parent) {
        aioHotspotsGroup.parent.remove(aioHotspotsGroup);
    }

    aioHotspotsGroup = null;
}

function buildAioHotspots() {
    disposeAioHotspots();
    activeAioNoteIndex = -1;

    aioHotspotsGroup = new THREE.Group();
    aioHotspotsGroup.name = 'aio-hotspots';
    aioHotspotsGroup.visible = (cameraMode === 'notes');

    aioNotes.forEach((note, index) => {
        if (!note.point) return;
        const tex = makeAioHotspotTexture(note);
        const mat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(note.point);
        sprite.userData.targetPx = Number.isFinite(note.order) ? 48 : 40;
        sprite.scale.set(1, 1, 1);
        sprite.renderOrder = 999;
        sprite.userData.aioIndex = index;
        sprite.userData.aioNote = note;
        aioHotspotsGroup.add(sprite);
    });

    if (modelGroup) {
        modelGroup.add(aioHotspotsGroup);
    }

    buildAioBillboards();       // <- NUEVO
    updateAioHotspotStyles();
    updateScreenSizedSprites();
}

function updateAioHotspotStyles() {
    if (aioHotspotsGroup) {
        aioHotspotsGroup.children.forEach((sprite, index) => {
            const note = sprite.userData.aioNote;
            const isActive = index === activeAioNoteIndex;

            if (sprite.material && note) {
                const tex = makeAioHotspotTexture(note);
                if (sprite.material.map) sprite.material.map.dispose();
                sprite.material.map = tex;
                sprite.material.needsUpdate = true;
                sprite.material.opacity = isActive ? 1.0 : 0.92;
            }

            sprite.userData.targetPx = isActive
                ? (Number.isFinite(note?.order) ? 56 : 48)
                : (Number.isFinite(note?.order) ? 48 : 40);
        });
    }

    if (aioBillboardsGroup) {
        aioBillboardsGroup.children.forEach(bb => {
            const idx = bb.userData.noteIndex;
            const note = bb.userData.note;
            const card = bb.userData.cardMesh;
            const line = bb.userData.line;
            const isActive = idx === activeAioNoteIndex;
            const mode = (note?.displayMode || 'ui').toLowerCase();

            const shouldShow = (
                cameraMode === 'notes' &&
                mode === 'billboard' &&
                isActive
            );

            bb.visible = shouldShow;

            if (card && card.material) {
                card.material.opacity = shouldShow ? 1.0 : 0.0;
                card.material.transparent = true;
            }

            if (line && line.material) {
                line.material.opacity = shouldShow ? 1.0 : 0.0;
                line.material.transparent = true;
            }
        });
    }
}

function disposeAioBillboards() {
    if (!aioBillboardsGroup) return;
    aioBillboardsGroup.traverse(obj => {
        if (obj.isMesh) {
            if (obj.material) {
                if (obj.material.map) obj.material.map.dispose();
                obj.material.dispose();
            }
            if (obj.geometry) obj.geometry.dispose();
        }
    });
    if (aioBillboardsGroup.parent) {
        aioBillboardsGroup.parent.remove(aioBillboardsGroup);
    }
    aioBillboardsGroup = null;
}

function createBillboardCardTexture(note) {
    const width = 512;
    const height = 320;
    const ctxCanvas = document.createElement('canvas');
    ctxCanvas.width = width;
    ctxCanvas.height = height;
    const ctx = ctxCanvas.getContext('2d');

    // Fondo
    ctx.fillStyle = 'rgba(15,23,42,0.96)';
    ctx.fillRect(0, 0, width, height);

    // Borde
    ctx.strokeStyle = 'rgba(148,163,184,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, width - 3, height - 3);

    // Padding interno
    const pad = 26;
    let x = pad;
    let y = pad;

    // Estado / categoría (chips)
    const colors = getAioStateColor(note.state || 'info');
    const chipH = 30;

    ctx.fillStyle = colors.fill;
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 2;
    const stateLabel = String(note.state || 'info').toUpperCase();
    ctx.font = 'bold 20px system-ui, -apple-system, sans-serif';
    const stateW = ctx.measureText(stateLabel).width + 22;

    ctx.beginPath();
    ctx.roundRect(x, y, stateW, chipH, 999);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colors.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(stateLabel, x + 11, y + chipH / 2);

    let chipRight = x + stateW;

    if (note.category) {
        const catLabel = String(note.category).toUpperCase();
        ctx.font = '500 18px system-ui, -apple-system, sans-serif';
        const catW = ctx.measureText(catLabel).width + 22;
        const gap = 10;
        const cx = chipRight + gap;

        ctx.fillStyle = 'rgba(148,163,184,0.18)';
        ctx.strokeStyle = 'rgba(148,163,184,0.6)';
        ctx.beginPath();
        ctx.roundRect(cx, y, catW, chipH, 999);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#e5e7eb';
        ctx.fillText(catLabel, cx + 11, y + chipH / 2);

        chipRight = cx + catW;
    }

    y += chipH + 16;

    // Área de imagen (si hay)
    let bodyX = x;
    let bodyW = width - pad * 2;
    const thumbSize = 140;
    let hasImage = !!note.image;

    if (hasImage) {
        const imgX = x;
        const imgY = y;
        const imgW = thumbSize * 1.4;
        const imgH = thumbSize;

        ctx.fillStyle = 'rgba(15,23,42,1)';
        ctx.fillRect(imgX, imgY, imgW, imgH);
        ctx.strokeStyle = 'rgba(51,65,85,1)';
        ctx.lineWidth = 2;
        ctx.strokeRect(imgX + 1, imgY + 1, imgW - 2, imgH - 2);

        ctx.fillStyle = '#64748b';
        ctx.font = '500 16px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('IMG', imgX + imgW / 2, imgY + imgH / 2);

        bodyX = imgX + imgW + 16;
        bodyW = width - pad - bodyX;
    }

    ctx.textAlign = 'left';

    // Título
    ctx.fillStyle = '#e5e7eb';
    ctx.font = '600 26px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const title = String(note.title || 'Sin título');
    const titleLines = wrapText(ctx, title, bodyW);
    titleLines.slice(0, 2).forEach(line => {
        ctx.fillText(line, bodyX, y + 26);
        y += 30;
    });
    y += 10;

    // Cuerpo
    ctx.fillStyle = '#cbd5f5';
    ctx.font = '400 18px system-ui, -apple-system, sans-serif';
    const body = String(note.body || '');
    const bodyLines = wrapText(ctx, body, bodyW);
    const maxBodyLines = hasImage ? 4 : 6;
    bodyLines.slice(0, maxBodyLines).forEach(line => {
        ctx.fillText(line, bodyX, y + 20);
        y += 24;
    });

    // Enlace (si detectamos URL)
    const urlMatch = body.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        const url = urlMatch[0];
        y += 18;
        const linkLabel = 'Abrir enlace';
        ctx.font = '500 18px system-ui, -apple-system, sans-serif';
        const linkW = ctx.measureText(linkLabel).width + 26;

        ctx.fillStyle = 'rgba(59,130,246,0.18)';
        ctx.strokeStyle = 'rgba(59,130,246,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(bodyX, y, linkW, 30, 999);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#93c5fd';
        ctx.textBaseline = 'middle';
        ctx.fillText(linkLabel, bodyX + 13, y + 15);

        // Guardamos url en userData en otro paso
        ctxCanvas._aioLinkUrl = url;
    }

    const tex = new THREE.CanvasTexture(ctxCanvas);
    tex.needsUpdate = true;
    tex.userData = tex.userData || {};
    tex.userData._canvas = ctxCanvas;
    return tex;
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';

    for (let w of words) {
        const test = current ? current + ' ' + w : w;
        const width = ctx.measureText(test).width;
        if (width > maxWidth && current) {
            lines.push(current);
            current = w;
        } else {
            current = test;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function buildAioBillboards() {
    disposeAioBillboards();

    aioBillboardsGroup = new THREE.Group();
    aioBillboardsGroup.name = 'aio-billboards';

    aioNotes.forEach((note, index) => {
        const mode = (note.displayMode || 'ui').toLowerCase();
        if (mode !== 'billboard') return;

        const worldPoint = getAioWorldPoint(note);
        if (!worldPoint) return;

        const root = new THREE.Group();
        root.name = `aio-billboard-${index}`;
        root.position.copy(worldPoint);

        const upLen = Math.max(modelSpan * 0.08, 1.2);
        const sideLen = Math.max(modelSpan * 0.05, 0.8);
        const cardLift = Math.max(modelSpan * 0.018, 0.24);

        const lineMat = new THREE.LineBasicMaterial({
            color: 0x60a5fa,
            transparent: true,
            opacity: 1
        });

        const lineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, upLen, 0),
            new THREE.Vector3(sideLen, upLen, 0)
        ]);

        const line = new THREE.Line(lineGeo, lineMat);
        root.add(line);

        const cardTex = createBillboardCardTexture(note);
        const cardGeo = new THREE.PlaneGeometry(1, 1);
        const cardMat = new THREE.MeshBasicMaterial({
            map: cardTex,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide
        });

        const card = new THREE.Mesh(cardGeo, cardMat);
        card.position.set(sideLen, upLen + cardLift, 0);
        card.userData.cardWidthPx = 320;
        card.userData.cardAspect = 320 / 512;
        card.userData.noteIndex = index;

        const canvas = cardTex.userData?.canvas;
        if (canvas && canvas.aioLinkUrl) {
            card.userData.linkUrl = canvas.aioLinkUrl;
        }

        root.add(card);

        root.userData.cardMesh = card;
        root.userData.line = line;
        root.userData.noteIndex = index;
        root.userData.note = note;
        root.userData.upLen = upLen;
        root.userData.sideLen = sideLen;
        root.userData.cardLift = cardLift;

        aioBillboardsGroup.add(root);
    });

    if (scene && aioBillboardsGroup.children.length) {
        scene.add(aioBillboardsGroup);
    }
}

function updateAioHotspotsVisibility() {
    if (aioHotspotsGroup) {
        aioHotspotsGroup.visible = (cameraMode === 'notes');
    }
    if (aioBillboardsGroup) {
    aioBillboardsGroup.children.forEach(bb => {
        const idx = bb.userData.noteIndex;
        const note = bb.userData.note;
        const card = bb.userData.cardMesh;
        const line = bb.userData.line;
        const isActive = idx === activeAioNoteIndex;

        const mode = (note.displayMode || 'ui').toLowerCase();
        const shouldShow = (
            cameraMode === 'notes' &&
            mode === 'billboard' &&
            isActive
        );

        bb.visible = shouldShow;

        if (card && card.material) {
            card.material.opacity = isActive ? 1.0 : 0.0;
        }

        if (line && line.material) {
            line.material.opacity = isActive ? 1.0 : 0.0;
            line.material.transparent = true;
        }
    });
}
}

function getWorldUnitsForScreenPixels(camera, worldPosition, pixelSize) {
    if (!camera || !renderer) return 1;

    const canvas = renderer.domElement;
    const heightPx = canvas.clientHeight || window.innerHeight || 1;

    if (camera.isPerspectiveCamera) {
        const camPos = new THREE.Vector3();
        camera.getWorldPosition(camPos);
        const distance = camPos.distanceTo(worldPosition);
        const fov = THREE.MathUtils.degToRad(camera.fov);
        const worldHeight = 2 * Math.tan(fov / 2) * distance;
        return (pixelSize * worldHeight) / heightPx;
    }

    if (camera.isOrthographicCamera) {
        const worldHeight = (camera.top - camera.bottom) / camera.zoom;
        return (pixelSize * worldHeight) / heightPx;
    }

    return 1;
}

function updateScreenSizedSprites() {
    if (!activeCamera) return;

    const span = Math.max(modelSpan, 1);

    if (aioHotspotsGroup) {
        aioHotspotsGroup.children.forEach(sprite => {
            if (!sprite.isSprite) return;

            const targetPx = sprite.userData.targetPx || 44;
            const worldPos = sprite.getWorldPosition(new THREE.Vector3());

            const screenSize = getWorldUnitsForScreenPixels(
                activeCamera,
                worldPos,
                targetPx
            );

            const minSize = span * 0.006;
            const maxSize = span * 0.028;

            const finalSize = THREE.MathUtils.clamp(screenSize, minSize, maxSize);
            sprite.scale.set(finalSize, finalSize, 1);
        });
    }

    if (aioBillboardsGroup) {
        aioBillboardsGroup.children.forEach(bb => {
            const card = bb.userData?.cardMesh;
            if (!card) return;

            const anchorWorld = bb.getWorldPosition(new THREE.Vector3());
            const targetPx = card.userData.cardWidthPx || 300;

            const screenWidth = getWorldUnitsForScreenPixels(
                activeCamera,
                anchorWorld,
                targetPx
            );

            const minWidth = span * 0.045;
            const maxWidth = span * 0.18;

            const worldWidth = THREE.MathUtils.clamp(screenWidth, minWidth, maxWidth);
            const aspect = card.userData.cardAspect || 0.625;

            card.scale.set(worldWidth, worldWidth * aspect, 1);
        });
    }
}

function getAioWorldPoint(note) {
    if (!note || !note.point) return null;
    const p = note.point.clone();

    if (modelGroup) {
        return modelGroup.localToWorld(p);
    }

    return p;
}



function easeInOutCubic(t) {
    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function getOrthoFocusZoom() {
    const minZoom = 1;
    const maxZoom = 120;

    const base = Math.max(modelSpan, 1);
    const desired = THREE.MathUtils.clamp(800 / base, 1.5, 40);

    return THREE.MathUtils.clamp(desired, minZoom, maxZoom);
}

function startAioOrthoFocusTransition(worldPoint) {
    if (!worldPoint || !orthoCamera || !orbitControls) return;

    const fromTarget = orbitControls.target.clone();
    const fromZoom = orthoCamera.zoom || 1;
    const toTarget = worldPoint.clone();
    const toZoom = Math.max(fromZoom, getOrthoFocusZoom());

    const travel = fromTarget.distanceTo(toTarget);
    const duration = THREE.MathUtils.clamp(260 + travel * 80, 320, 900);

    orthoFocusAnim = {
        startTime: performance.now(),
        duration,
        fromTarget,
        toTarget,
        fromZoom,
        toZoom
    };
}

function updateOrthoFocusAnimation(now) {
    if (!orthoFocusAnim || !orthoCamera || !orbitControls) return;

    const a = orthoFocusAnim;
    const t = THREE.MathUtils.clamp((now - a.startTime) / a.duration, 0, 1);
    const k = easeInOutCubic(t);

    orbitControls.target.lerpVectors(a.fromTarget, a.toTarget, k);

    const nextZoom = THREE.MathUtils.lerp(a.fromZoom, a.toZoom, k);
    orthoCamera.zoom = nextZoom;
    orthoCamera.updateProjectionMatrix();

    const dist = Math.max(modelSpan * 5, 10);
    orthoCamera.position.set(
        orbitControls.target.x,
        orbitControls.target.y + dist,
        orbitControls.target.z
    );
    orthoCamera.lookAt(orbitControls.target);
    orthoCamera.rotation.set(-Math.PI / 2, 0, 0);

    orbitControls.update();

    if (t >= 1) {
        orthoFocusAnim = null;
    }
}

function getSafeFocusDistance(currentDistance) {
    const minDist = Math.max(modelSpan * 0.22, 2.0);
    const maxDist = Math.max(modelSpan * 1.4, 12);
    return THREE.MathUtils.clamp(currentDistance * 0.82, minDist, maxDist);
}

function startAioFocusTransition(worldPoint, note = null) {
    if (!worldPoint || !orbitCamera || !orbitControls) return;

    const currentTarget = orbitControls.target.clone();
    const currentPos = orbitCamera.position.clone();
    const currentOffset = new THREE.Vector3().subVectors(currentPos, currentTarget);

    let currentDistance = currentOffset.length();
    if (!Number.isFinite(currentDistance) || currentDistance < 1e-6) {
        currentOffset.set(1, 0.6, 1).normalize();
        currentDistance = Math.max(modelSpan * 0.5, 4);
    }

    const direction = currentOffset.clone().normalize();
    const desiredDistance = getSafeFocusDistance(currentDistance);

    const focusPoint = note ? getAioFocusPoint(note) : worldPoint.clone();
    const framingLift = note ? Math.max(modelSpan * 0.04, 0.5) : 0;
    const toTarget = focusPoint.clone().add(new THREE.Vector3(0, framingLift, 0));

    let targetCamPos = toTarget.clone().addScaledVector(direction, desiredDistance);

    const toPoint = new THREE.Vector3().subVectors(toTarget, targetCamPos);
    const rayDir = toPoint.clone().normalize();
    const rayLen = toPoint.length();

    raycaster.set(targetCamPos, rayDir);
    const hits = raycaster.intersectObjects(groundMeshes, false);

    if (hits.length > 0 && hits[0].distance < rayLen) {
        const pushBack = Math.max(modelSpan * 0.08, 0.8);
        targetCamPos = hits[0].point.clone().addScaledVector(direction, pushBack);
    }

    const travel =
        currentPos.distanceTo(targetCamPos) +
        currentTarget.distanceTo(toTarget);

    const duration = THREE.MathUtils.clamp(320 + travel * 70, 420, 1000);

    cameraFocusAnim = {
        startTime: performance.now(),
        duration,
        fromPos: currentPos,
        toPos: targetCamPos,
        fromTarget: currentTarget,
        toTarget
    };
}

function updateCameraFocusAnimation(now) {
    if (!cameraFocusAnim || !orbitControls || !orbitCamera) return;

    const a = cameraFocusAnim;
    const t = THREE.MathUtils.clamp((now - a.startTime) / a.duration, 0, 1);
    const k = easeInOutCubic(t);

    orbitCamera.position.lerpVectors(a.fromPos, a.toPos, k);
    orbitControls.target.lerpVectors(a.fromTarget, a.toTarget, k);
    orbitControls.update();

    if (t >= 1) {
        cameraFocusAnim = null;
    }
}

function setActiveAioNote(index, shouldFocus = true) {
    if (!Array.isArray(aioNotes) || index < 0 || index >= aioNotes.length) return;

    activeAioNoteIndex = index;
    const note = aioNotes[index];

    if (shouldFocus) {
        if (cameraMode !== 'notes') {
            setCameraMode('notes');
        }

        const focusPoint = getAioWorldPoint(note);

        if (focusPoint) {
            if (activeCamera && activeCamera.isOrthographicCamera) {
                startAioOrthoFocusTransition(focusPoint);
            } else {
                startAioFocusTransition(focusPoint, note);
            }
        }
    }

    const mode = (note.displayMode || 'ui').toLowerCase();
    if (mode === 'billboard') {
        hideAioNoteCard();
    } else {
        showAioNoteCard(note, index);
    }

    updateAioHotspotStyles();
}


function getAioFocusPoint(note) {
    const worldPoint = getAioWorldPoint(note);
    if (!worldPoint) return null;

    const lift = Math.max(modelSpan * 0.10, 1.2);
    return worldPoint.clone().add(new THREE.Vector3(0, lift, 0));
}

function getAioFrameOffset(note) {
    const upLen = Math.max(modelSpan * 0.08, 1.2);
    const sideLen = Math.max(modelSpan * 0.05, 0.8);
    const cardLift = Math.max(modelSpan * 0.018, 0.24);

    return {
        upLen,
        sideLen,
        cardLift,
        totalLift: upLen + cardLift
    };
}


    function rhinoXformToMatrix4(xform) {
        const identity = new THREE.Matrix4();

        try {
            if (!xform) return identity;

            let arr = null;

            if (typeof xform.toFloatArray === 'function') {
                try {
                    arr = xform.toFloatArray(true);
                } catch (e) {
                    try {
                        arr = xform.toFloatArray(false);
                    } catch (e2) {
                        if (DEBUG_RHINO) console.warn('Aio Visor: toFloatArray falló', e2);
                    }
                }
            }

            if ((!arr || arr.length !== 16) && typeof xform.toArray === 'function') {
                try {
                    arr = xform.toArray();
                } catch (e) {
                    if (DEBUG_RHINO) console.warn('Aio Visor: toArray falló', e);
                }
            }

            if ((!arr || arr.length !== 16) && Array.isArray(xform) && xform.length === 16) {
                arr = xform;
            }

            if ((!arr || arr.length !== 16) && typeof xform === 'object') {
                const values = [];
                for (let r = 0; r < 4; r++) {
                    for (let c = 0; c < 4; c++) {
                        const v = xform[r]?.[c];
                        values.push(typeof v === 'number' ? v : 0);
                    }
                }
                if (values.length === 16) arr = values;
            }

            if (!arr || arr.length !== 16) {
                if (DEBUG_RHINO) console.warn('Aio Visor: Transform no reconocida, usando identidad.', xform);
                return identity;
            }

            return new THREE.Matrix4().fromArray(arr);
        } catch (e) {
            if (DEBUG_RHINO) console.warn('Aio Visor: Error convirtiendo transform, usando identidad.', e);
            return identity;
        }
    }

    function rhinoGeomToThreeObjs(geom, rhino, appearance, audit) {
        const results = [];
        const hex = appearance.hexColor;
        const lname = appearance.layerName;
        const ctorName = getGeomCtorName(geom);
        const safeLabel = getGeomObjectTypeLabel(geom);

        const processMesh = (rhinoMesh, debugLabel = '') => {
            if (!rhinoMesh) return false;

            try {
                const jsonStr = rhinoMesh.toThreejsJSON();
                const jsonObj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;

                if (!jsonObj) {
                    if (DEBUG_RHINO) console.warn(`Aio Visor: Malla vacía (${debugLabel})`);
                    return false;
                }

                const geo = new THREE.BufferGeometryLoader().parse(jsonObj);

                if (!geo || !geo.attributes || !geo.attributes.position || geo.attributes.position.count === 0) {
                    if (DEBUG_RHINO) console.warn(`Aio Visor: BufferGeometry inválida o vacía (${debugLabel})`);
                    return false;
                }

                geo.computeVertexNormals();

                const matSet = buildMatSet(hex, lname);
                const mesh = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);

                meshMatCache[mesh.uuid] = matSet;
                if (audit) audit.meshObjects += 1;

                results.push(mesh);
                return true;
            } catch (e) {
                if (DEBUG_RHINO) console.warn(`Aio Visor: No se pudo parsear la malla (${debugLabel})`, e);
                return false;
            }
        };

        const processMeshCandidate = (candidate, debugLabel = '') => {
            let success = false;

            if (!candidate) return false;

            if (Array.isArray(candidate)) {
                candidate.forEach((m, i) => {
                    if (processMesh(m, `${debugLabel}[${i}]`)) success = true;
                });
                return success;
            }

            if (typeof candidate.count === 'number' && typeof candidate.get === 'function') {
                for (let i = 0; i < candidate.count; i++) {
                    const m = candidate.get(i);
                    if (processMesh(m, `${debugLabel}[${i}]`)) success = true;
                }
                return success;
            }

            return processMesh(candidate, debugLabel);
        };

        try {
            if (!geom) return results;

            if (typeof geom.toThreejsJSON === 'function') {
                const ok = processMeshCandidate(geom, `DirectMesh-${safeLabel}`);
                auditInc(audit?.byOutcome, ok ? 'direct-mesh-success' : 'direct-mesh-empty');
                return results;
            }

            if (typeof geom.getMesh === 'function') {
                const meshTypes = [
                    rhino.MeshType.Any,
                    rhino.MeshType.Render,
                    rhino.MeshType.Preview,
                    rhino.MeshType.Default
                ];

                let foundMesh = false;

                for (let t of meshTypes) {
                    let rm = null;

                    try {
                        rm = geom.getMesh(t);
                    } catch (e) {
                        if (DEBUG_RHINO) console.warn(`Aio Visor: getMesh falló para tipo ${safeLabel} / MeshType ${t}`, e);
                        continue;
                    }

                    const ok = processMeshCandidate(rm, `${safeLabel}-MeshType-${t}`);
                    if (ok) foundMesh = true;

                    if (rm && typeof rm.delete === 'function') {
                        try {
                            rm.delete();
                        } catch (e) {}
                    }

                    if (foundMesh) break;
                }

                if (!foundMesh) {
                    auditInc(audit?.byOutcome, `${ctorName}:no-render-mesh`);
                    if (DEBUG_RHINO) {
                        console.warn(
                            `Aio Visor: ${safeLabel} / ${ctorName} sin render mesh utilizable. Puede ser un límite de rhino3dm o un archivo guardado sin render meshes.`
                        );
                    }
                } else {
                    auditInc(audit?.byOutcome, `${ctorName}:mesh-success`);
                }

                return results;
            }

            if (typeof geom.pointAt === 'function') {
                try {
                    let d0 = 0;
                    let d1 = 1;

                    if (geom.domain) {
                        if (Array.isArray(geom.domain)) {
                            d0 = geom.domain[0];
                            d1 = geom.domain[1];
                        } else if (typeof geom.domain === 'function') {
                            const d = geom.domain();
                            if (Array.isArray(d)) {
                                d0 = d[0];
                                d1 = d[1];
                            } else if (d && d[0] !== undefined && d[1] !== undefined) {
                                d0 = d[0];
                                d1 = d[1];
                            } else if (d && d.t0 !== undefined && d.t1 !== undefined) {
                                d0 = d.t0;
                                d1 = d.t1;
                            }
                        } else if (geom.domain.t0 !== undefined && geom.domain.t1 !== undefined) {
                            d0 = geom.domain.t0;
                            d1 = geom.domain.t1;
                        }
                    }

                    const pts = [];

                    for (let i = 0; i <= 100; i++) {
                        const t = d0 + (d1 - d0) * (i / 100);
                        const p = geom.pointAt(t);
                        if (!p) continue;

                        const x = p.x !== undefined ? p.x : p[0];
                        const y = p.y !== undefined ? p.y : p[1];
                        const z = p.z !== undefined ? p.z : p[2];

                        if ([x, y, z].every(v => typeof v === 'number' && isFinite(v))) {
                            pts.push(new THREE.Vector3(x, y, z));
                        }
                    }

                    if (pts.length >= 2) {
                        const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
                        const lineMat = new THREE.LineBasicMaterial({ color: hex });

                        if (audit) audit.lineObjects += 1;
                        auditInc(audit?.byOutcome, `${ctorName}:curve-success`);

                        results.push(new THREE.Line(lineGeo, lineMat));
                    } else {
                        auditInc(audit?.byOutcome, `${ctorName}:curve-empty`);
                        if (DEBUG_RHINO) {
                            console.warn(`Aio Visor: Curva ${safeLabel} sin puntos suficientes para dibujarse.`);
                        }
                    }
                } catch (e) {
                    auditInc(audit?.byOutcome, `${ctorName}:curve-error`);
                    if (audit) audit.errors += 1;
                    if (DEBUG_RHINO) console.warn(`Aio Visor: Error dibujando curva ${safeLabel}`, e);
                }

                return results;
            }

            auditInc(audit?.byOutcome, `${ctorName}:unsupported`);
            if (audit) audit.unsupportedObjects += 1;
            return results;
        } catch (e) {
            auditInc(audit?.byOutcome, `${ctorName}:error`);
            if (audit) audit.errors += 1;
            if (DEBUG_RHINO) {
                console.warn(`Aio Visor: Error general convirtiendo geometría ${safeLabel}`, e);
            }
            return results;
        }
    }

    function processDocObjects(doc, rhino, shadowEnabled, audit) {
        const group = new THREE.Group();
        const objs = doc.objects();

        layerMeshes = {};

                aioNotes = [];
        hasAioNotes = false;

        function safeDelete(obj) {
            if (obj && typeof obj.delete === 'function') {
                try {
                    obj.delete();
                } catch (e) {}
            }
        }

        function recurse(obj, parent, depth = 0) {
            if (!obj) return;

            let geom = null;

            try {
                geom = obj.geometry();
                if (!geom) return;

                const aioNote = parseAioNote(obj, geom);
                if (aioNote) {
                    aioNotes.push(aioNote);
                }

                const objectType = geom.objectType;
                const objectTypeLabel = getGeomObjectTypeLabel(geom);
                const ctorName = getGeomCtorName(geom);

                if (audit) {
                    audit.totalObjects += 1;
                    auditInc(audit.byCtor, ctorName);
                    auditInc(audit.byDepth, `depth-${depth}`);
                }

                if (rhino.ObjectType && objectType === rhino.ObjectType.InstanceReference) {
                    try {
                        if (audit) {
                            audit.instanceRefs += 1;
                            auditInc(audit.byOutcome, 'InstanceReference:expanded');
                        }

                        const idefId = geom.parentIdefId;
                        const idef = doc.instanceDefinitions().findId(idefId);

                        if (!idef) {
                            auditInc(audit?.byOutcome, 'InstanceReference:missing-definition');
                            if (audit) audit.errors += 1;
                            if (DEBUG_RHINO) {
                                console.warn('Aio Visor: InstanceReference sin definición válida.', idefId);
                            }
                            return;
                        }

                        const bg = new THREE.Group();
                        const objectIds = idef.getObjectIds();

                        if (Array.isArray(objectIds)) {
                            objectIds.forEach(id => {
                                try {
                                    const childObj = doc.objects().findId(id);
                                    if (childObj) recurse(childObj, bg, depth + 1);
                                } catch (e) {
                                    if (DEBUG_RHINO) {
                                        console.warn('Aio Visor: Error procesando objeto dentro de bloque.', e);
                                    }
                                }
                            });
                        } else if (
                            typeof objectIds?.count === 'number' &&
                            typeof objectIds?.get === 'function'
                        ) {
                            for (let i = 0; i < objectIds.count; i++) {
                                try {
                                    const id = objectIds.get(i);
                                    const childObj = doc.objects().findId(id);
                                    if (childObj) recurse(childObj, bg, depth + 1);
                                } catch (e) {
                                    if (DEBUG_RHINO) {
                                        console.warn('Aio Visor: Error procesando objeto dentro de bloque.', e);
                                    }
                                }
                            }
                        }

                        bg.applyMatrix4(rhinoXformToMatrix4(geom.xform));
                        parent.add(bg);
                        return;
                    } catch (e) {
                        auditInc(audit?.byOutcome, 'InstanceReference:error');
                        if (audit) audit.errors += 1;
                        if (DEBUG_RHINO) console.warn('Aio Visor: Error procesando InstanceReference.', e);
                        return;
                    }
                }

                try {
                    const app = getObjAppearance(obj, doc);
                    const tojs = rhinoGeomToThreeObjs(geom, rhino, app, audit);

                    if (audit) {
                        if (tojs.length > 0) audit.convertedObjects += 1;
                        else audit.emptyResults += 1;
                    }

                    tojs.forEach(o => {
                        if (o.isMesh) o.castShadow = o.receiveShadow = shadowEnabled;
                        parent.add(o);

                        const ln = app.layerName || 'Default';
                        if (!layerMeshes[ln]) layerMeshes[ln] = [];
                        layerMeshes[ln].push(o);
                    });
                } catch (e) {
                    auditInc(audit?.byOutcome, `${ctorName}:conversion-error`);
                    if (audit) audit.errors += 1;
                    if (DEBUG_RHINO) {
                        console.warn(`Aio Visor: Error convirtiendo objeto type=${objectTypeLabel}`, e);
                    }
                }
            } catch (e) {
                auditInc(audit?.byOutcome, 'recurse:error');
                if (audit) audit.errors += 1;
                if (DEBUG_RHINO) {
                    console.warn('Aio Visor: Error general procesando objeto del documento.', e);
                }
            } finally {
                safeDelete(geom);
            }
        }

        for (let i = 0; i < objs.count; i++) {
            try {
                recurse(objs.get(i), group, 0);
            } catch (e) {
                auditInc(audit?.byOutcome, 'root:error');
                if (audit) audit.errors += 1;
                if (DEBUG_RHINO) {
                    console.warn(`Aio Visor: Error en objeto raíz índice ${i}`, e);
                }
            }
        }

            aioNotes.sort((a, b) => {
            const ao = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
            const bo = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
            if (ao !== bo) return ao - bo;
            return a.title.localeCompare(b.title);
        });

        hasAioNotes = aioNotes.length > 0;

        return group;
    }

    async function loadModel() {
        const config = await loadModelConfig();
        if (!config || !config.archivo) {
            showLoading('Error: Modelo no encontrado para este ID');
            return;
        }

        const filePath = config.resolved_url || config.archivo;
        const displayName = config.nombre || filePath;

        showLoading('Cargando ' + displayName + '...');

        rhino3dm().then(async rhino => {
            try {
                disposeAioHotspots();
                const res = await fetch(filePath);
                if (!res.ok) throw new Error('Model not found');

                const doc = rhino.File3dm.fromByteArray(
                    new Uint8Array(await res.arrayBuffer())
                );

                const audit = createRhinoAudit();
                const group = processDocObjects(
                    doc,
                    rhino,
                    document.getElementById('toggle-shadows').checked,
                    audit
                );

                printRhinoAudit(audit, displayName);

                doc.delete();

                if (group.children.length === 0) {
                    throw new Error('No geometry found');
                }

                group.rotation.x = -Math.PI / 2;
                scene.add(group);
                modelGroup = group;

                const box = new THREE.Box3().setFromObject(group);
                box.getCenter(modelCenter);
                box.getSize(modelSize);
                modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;

                group.position.y += -box.min.y;
                modelCenter.y += -box.min.y;

                groundMeshes = [];
                group.traverse(c => {
                    if (c.isMesh) groundMeshes.push(c);
                });

                is2DModel = groundMeshes.length === 0;

                resetCamera();
                syncOrthoCamera();
                setCameraMode(is2DModel ? 'ortho' : 'orbit');
                updateLayersUI();
                applyStyle(visualStyle);
                updateSun();
                hideLoading();

                console.log('AIO DEBUG', { hasAioNotes, aioNotes });

                applyUIConfig(config);
                if (hasAioNotes) {
                    buildAioHotspots();
                    updateAioHotspotsVisibility();
                }
            } catch (e) {
                console.error(e);
                showLoading('Error: ' + e.message);
            }
        });
    }

    async function loadModelConfig() {
        const modelId = getModelFromQuery();
        if (!modelId) return null;

        try {
            const items = await loadContent();
            const match = items.find(m => m.id === modelId);
            return match || null;
        } catch (e) {
            console.warn('Config not available:', e);
            return null;
        }
    }

       function applyUIConfig(config) {
    if (!config) return;

    if (Array.isArray(config.cameraModes)) {
        document.querySelectorAll('.cam-btn[data-mode]').forEach(btn => {
            if (!config.cameraModes.includes(btn.dataset.mode)) {
                btn.style.display = 'none';
            }
        });
    }

    const notesBtn = document.querySelector('.cam-btn[data-mode="notes"]');
    if (notesBtn) {
        notesBtn.style.display = hasAioNotes ? '' : 'none';
    }

    if (Array.isArray(config.visualStyles)) {
        document.querySelectorAll('.style-btn[data-style]').forEach(btn => {
            if (!config.visualStyles.includes(btn.dataset.style)) {
                btn.style.display = 'none';
            }
        });
    }

    if (config.showLayers === false) {
        const panel = document.getElementById('layers-panel');
        if (panel) panel.style.display = 'none';
    }

    if (config.showLighting === false) {
        const env = document.getElementById('env-controls');
        if (env) env.style.display = 'none';
    }

    if (config.showShadows === false) {
        const toggle = document.getElementById('toggle-shadows');
        if (toggle) {
            toggle.checked = false;
            if (toggle.parentElement) toggle.parentElement.style.display = 'none';
        }
        toggleShadows(false);
    }
}

    function init() {
        scene = new THREE.Scene();

        renderer = new THREE.WebGLRenderer({
            antialias: true,
            logarithmicDepthBuffer: true
        });

        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.95;
        renderer.outputEncoding = THREE.sRGBEncoding;

        document.body.appendChild(renderer.domElement);

        const aspect = window.innerWidth / window.innerHeight;

        orbitCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000000);
        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.dampingFactor = 0.08;

        walkCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        walkCamera.rotation.order = 'YXZ';

        flyCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000);
        flyCamera.rotation.order = 'YXZ';

        orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);

        activeCamera = orbitCamera;

        scene.add(new THREE.HemisphereLight(0xd6e4f0, 0x3a3020, 0.65));

        sun = new THREE.DirectionalLight(0xfff5e0, 1.2);
        sun.castShadow = true;
        sun.shadow.mapSize.width = sun.shadow.mapSize.height = 2048;
        scene.add(sun);
        scene.add(sun.target);

        fill = new THREE.DirectionalLight(0x8899cc, 0.3);
        fill.position.set(-5, 2, -5);
        scene.add(fill);

        window.addEventListener('resize', () => {
            renderer.setSize(window.innerWidth, window.innerHeight);

            const a = window.innerWidth / window.innerHeight;
            orbitCamera.aspect = walkCamera.aspect = flyCamera.aspect = a;

            orbitCamera.updateProjectionMatrix();
            walkCamera.updateProjectionMatrix();
            flyCamera.updateProjectionMatrix();

            syncOrthoCamera();
        });

        window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Digit1') setCameraMode('orbit');
    if (e.code === 'Digit2') setCameraMode('walk');
    if (e.code === 'Digit3') setCameraMode('fly');
    if (e.code === 'Digit4') setCameraMode('ortho');
    if (e.code === 'Digit5') setCameraMode('notes');
    if (e.code === 'KeyR') resetCamera();
});

        window.addEventListener('keyup', e => {
            keys[e.code] = false;
        });

        window.addEventListener('mousemove', e => {
            if (
                (cameraMode !== 'walk' && cameraMode !== 'fly') ||
                document.pointerLockElement !== renderer.domElement
            )
                return;

            yaw -= e.movementX * 0.002;
            pitch -= e.movementY * 0.002;
            pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch));

            if (cameraMode === 'walk') {
                walkCamera.rotation.set(pitch, yaw, 0, 'YXZ');
            } else {
                flyCamera.rotation.set(pitch, yaw, 0, 'YXZ');
            }
        });

       renderer.domElement.addEventListener('click', (e) => {
    if (cameraMode === 'walk' || cameraMode === 'fly') {
        renderer.domElement.requestPointerLock();
        return;
    }

    if (!activeCamera) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
    );

    raycaster.setFromCamera(mouse, activeCamera);

    // 1) Billboards: primero probamos tarjeta
    if (aioBillboardsGroup) {
        const hitsBB = raycaster.intersectObjects(aioBillboardsGroup.children, true);
        if (hitsBB.length > 0) {
            const obj = hitsBB[0].object;
            let bbRoot = obj;
            while (bbRoot && bbRoot.parent && bbRoot !== aioBillboardsGroup) {
                bbRoot = bbRoot.parent;
            }
            if (bbRoot && bbRoot.userData && Number.isInteger(bbRoot.userData.noteIndex)) {
                const idx = bbRoot.userData.noteIndex;
                setActiveAioNote(idx, true);

                const card = bbRoot.userData.cardMesh;
                if (card && card.userData && card.userData.linkUrl) {
                    window.open(card.userData.linkUrl, '_blank', 'noopener');
                }
                return;
            }
        }
    }

    // 2) Hotspots
    if (!aioHotspotsGroup) return;
    const hits = raycaster.intersectObjects(aioHotspotsGroup.children, true);
    if (hits.length === 0) return;
    const hit = hits[0].object;
    const idx = hit.userData?.aioIndex;
    if (Number.isInteger(idx)) {
        setActiveAioNote(idx, true);
    }
});
        document.getElementById('sun-az').addEventListener('input', updateSun);
        document.getElementById('sun-el').addEventListener('input', updateSun);
        document.getElementById('toggle-shadows').addEventListener('change', e => {
            toggleShadows(e.target.checked);
        });
        document.getElementById('bg-select').addEventListener('change', e => {
            changeBackground(e.target.value);
        });
        document.getElementById('ortho-toggle').addEventListener('click', toggleOrtho);

        document.querySelectorAll('.cam-btn[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => setCameraMode(btn.dataset.mode));
        });

        document.querySelectorAll('.style-btn').forEach(btn => {
            btn.addEventListener('click', () => applyStyle(btn.dataset.style));
        });

        const aioPrevBtn = document.getElementById('aio-note-prev');
const aioNextBtn = document.getElementById('aio-note-next');
const aioCloseBtn = document.getElementById('aio-note-close');

if (aioPrevBtn) {
    aioPrevBtn.addEventListener('click', function() {
        if (!aioNotes.length) return;
        const nextIndex = activeAioNoteIndex > 0 ? activeAioNoteIndex - 1 : aioNotes.length - 1;
        setActiveAioNote(nextIndex, true);
    });
}

if (aioNextBtn) {
    aioNextBtn.addEventListener('click', function() {
        if (!aioNotes.length) return;
        const nextIndex = activeAioNoteIndex >= 0
            ? (activeAioNoteIndex + 1) % aioNotes.length
            : 0;
        setActiveAioNote(nextIndex, true);
    });
}

if (aioCloseBtn) {
    aioCloseBtn.addEventListener('click', function() {
        activeAioNoteIndex = -1;
        updateAioHotspotStyles();
        hideAioNoteCard();
    });
}

        changeBackground('grey');
        loadModel();

        (function anim() {
            requestAnimationFrame(anim);

            const spd = modelSpan * 0.004;
            const rad = 0.5;

            if (cameraMode === 'walk') {
                const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
                const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
                const m = new THREE.Vector3();

                if (keys['KeyW']) m.add(f);
                if (keys['KeyS']) m.addScaledVector(f, -1);
                if (keys['KeyA']) m.addScaledVector(r, -1);
                if (keys['KeyD']) m.add(r);

                if (m.lengthSq() > 0) {
                    velocity.addScaledVector(m.normalize(), spd);
                }

                velocity.multiplyScalar(damping);

                const next = walkCamera.position.clone().add(velocity);
                next.y = getGroundY(next.x, next.z) + WALK_HEIGHT;

                if (!checkCollision(next, rad)) {
                    walkCamera.position.copy(next);
                } else {
                    velocity.set(0, 0, 0);
                }
            } else if (cameraMode === 'fly') {
                const f = new THREE.Vector3();
                const r = new THREE.Vector3();

                flyCamera.getWorldDirection(f);
                r.crossVectors(f, flyCamera.up).normalize();

                const m = new THREE.Vector3();

                if (keys['KeyW']) m.add(f);
                if (keys['KeyS']) m.addScaledVector(f, -1);
                if (keys['KeyA']) m.addScaledVector(r, -1);
                if (keys['KeyD']) m.add(r);
                if (keys['Space']) m.y += 1;
                if (keys['ShiftLeft']) m.y -= 1;

                if (m.lengthSq() > 0) {
                    velocity.addScaledVector(m.normalize(), spd);
                }

                velocity.multiplyScalar(damping);

                const next = flyCamera.position.clone().add(velocity);

                if (!checkCollision(next, rad)) {
                    flyCamera.position.copy(next);
                } else {
                    velocity.set(0, 0, 0);
                }
            } else if (cameraMode === 'orbit' || cameraMode === 'notes') {
    orbitControls.update();
}
            updateScreenSizedSprites();
            updateCameraFocusAnimation(performance.now());
            updateOrthoFocusAnimation(performance.now());
            // NUEVO: orientar tarjetas de billboard hacia la cámara
    if (aioBillboardsGroup && activeCamera) {
    const camPos = new THREE.Vector3();
    activeCamera.getWorldPosition(camPos);

    const camDir = new THREE.Vector3();
    activeCamera.getWorldDirection(camDir);

    const worldUp = new THREE.Vector3(0, 1, 0);
    const lateral = new THREE.Vector3().crossVectors(worldUp, camDir).normalize();

    if (lateral.lengthSq() < 1e-6) {
        lateral.set(1, 0, 0);
    }

    aioBillboardsGroup.children.forEach(bb => {
        const card = bb.userData && bb.userData.cardMesh;
        const line = bb.userData && bb.userData.line;
        if (!card || !line) return;

        const upLen = bb.userData.upLen || Math.max(modelSpan * 0.08, 1.2);
        const sideLen = bb.userData.sideLen || Math.max(modelSpan * 0.05, 0.8);
        const cardLift = bb.userData.cardLift || Math.max(modelSpan * 0.015, 0.22);

        const idx = bb.userData.noteIndex;
        const sign = (idx % 2 === 0) ? 1 : -1;
        const sideVec = lateral.clone().multiplyScalar(sideLen * sign);

        const p0 = new THREE.Vector3(0, 0, 0);
        const p1 = new THREE.Vector3(0, upLen, 0);
        const p2 = p1.clone().add(sideVec);

        line.geometry.setFromPoints([p0, p1, p2]);

        card.position.copy(p2).add(new THREE.Vector3(0, cardLift, 0));
        card.lookAt(camPos);
    });
}
        
            if (aioBillboardsGroup && activeCamera) {
    const camPos = new THREE.Vector3();
    activeCamera.getWorldPosition(camPos);

    const camDir = new THREE.Vector3();
    activeCamera.getWorldDirection(camDir);

    const worldUp = new THREE.Vector3(0, 1, 0);
    const lateral = new THREE.Vector3().crossVectors(worldUp, camDir).normalize();

    if (lateral.lengthSq() < 1e-6) {
        lateral.set(1, 0, 0);
    }

    aioBillboardsGroup.children.forEach(bb => {
        const card = bb.userData?.cardMesh;
        const line = bb.userData?.line;
        if (!card || !line) return;

        const upLen = bb.userData.upLen || Math.max(modelSpan * 0.08, 1.2);
        const sideLen = bb.userData.sideLen || Math.max(modelSpan * 0.05, 0.8);
        const cardLift = bb.userData.cardLift || Math.max(modelSpan * 0.018, 0.24);

        const idx = bb.userData.noteIndex || 0;
        const sideVec = lateral.clone().multiplyScalar((idx % 2 === 0 ? 1 : -1) * sideLen);

        const p0 = new THREE.Vector3(0, 0, 0);
        const p1 = new THREE.Vector3(0, upLen, 0);
        const p2 = p1.clone().add(sideVec);

        line.geometry.setFromPoints([p0, p1, p2]);

        card.position.copy(p2).add(new THREE.Vector3(0, cardLift, 0));
        card.lookAt(camPos);
    });
}
            renderer.render(scene, activeCamera);
        })();
    }

    init();
})();
