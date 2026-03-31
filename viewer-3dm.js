(function() {
    'use strict';
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
    let layerMeshes = {}; // layerName -> Mesh[]

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
        // Ahora devuelve el id del item (coincide con lo que usa index.html / DirArc)
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
            console.warn('No se pudieron leer items locales:', e);
            return [];
        }
    }

    function isLocalSource() {
        return getQueryParam('source') === 'local';
    }

       async function loadContent() {
        if (isLocalSource()) {
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
        const azEl = document.getElementById('az-val'), elEl = document.getElementById('el-val');
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
        sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
        sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
        sun.shadow.camera.updateProjectionMatrix();
    }

    function changeBackground(type) {
        if (!scene) return;
        if (sky) { scene.remove(sky); sky = null; skyUniforms = null; }
        if (type === 'black') scene.background = new THREE.Color(0x050608);
        else if (type === 'white') scene.background = new THREE.Color(0xffffff);
        else if (type === 'grey') scene.background = new THREE.Color(0x22262e);
        else if (type === 'sky' || type === 'sunset') {
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
            canvas.width = 2; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            grad.addColorStop(0, '#020617'); grad.addColorStop(1, '#1e293b');
            ctx.fillStyle = grad; ctx.fillRect(0, 0, 2, 512);
            scene.background = new THREE.CanvasTexture(canvas);
        }
    }

    function toggleShadows(enabled) {
        if (!renderer || !sun) return;
        sun.castShadow = enabled;
        if (modelGroup) {
            modelGroup.traverse(function(obj) {
                if (obj.isMesh) obj.castShadow = obj.receiveShadow = enabled;
            });
        }
    }

    // ── Camera mode UI ───────────────────────────────────────────────────────
    function updateModeUI() {
        const labels = { orbit: 'Orbit', walk: 'Walk', fly: 'Fly', ortho: 'Top View' };
        const el = document.getElementById('mode-label');
        if (el) el.textContent = labels[cameraMode] || cameraMode;
        document.querySelectorAll('.cam-btn[data-mode]').forEach(function(b) {
            b.classList.toggle('active', b.dataset.mode === cameraMode);
        });
        document.dispatchEvent(new CustomEvent('modchange', { detail: cameraMode }));
    }

    function setCameraMode(mode) {
        if (is2DModel && mode !== 'ortho') return;
        const prev = cameraMode;
        cameraMode = mode;
        if ((prev === 'walk' || prev === 'fly') && document.pointerLockElement) document.exitPointerLock();
        if (mode === 'orbit') {
            activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
            orbitControls.object = activeCamera;
            orbitControls.enabled = true;
            orbitControls.enableRotate = true;
            orbitControls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
        } else if (mode === 'walk') {
            activeCamera = walkCamera; orbitControls.enabled = false;
            const target = orbitControls.target.clone();
            const groundY = getGroundY(target.x, target.z);
            walkCamera.position.set(target.x, groundY + WALK_HEIGHT, target.z + modelSpan * 0.05);
            walkCamera.rotation.set(0, 0, 0, 'YXZ');
            yaw = 0; pitch = 0;
        } else if (mode === 'fly') {
            activeCamera = flyCamera; orbitControls.enabled = false;
            flyCamera.position.copy(orbitCamera.position); flyCamera.lookAt(orbitControls.target);
            yaw = flyCamera.rotation.y; pitch = flyCamera.rotation.x;
        } else if (mode === 'ortho') {
            activeCamera = orthoCamera;
            orbitControls.object = orthoCamera;
            orbitControls.enabled = true;
            orbitControls.enableRotate = false;
            orbitControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
            syncOrthoCamera();
        }
        velocity.set(0, 0, 0);
        updateModeUI();
    }

    function toggleOrtho() {
        isOrthoOrbit = !isOrthoOrbit;
        const btn = document.getElementById('ortho-toggle');
        if (btn) btn.classList.toggle('active', isOrthoOrbit);
        if (cameraMode === 'orbit') {
            activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
            if (isOrthoOrbit) syncOrthoCamera();
            orbitControls.object = activeCamera;
            orbitControls.update();
        }
    }

    function syncOrthoCamera() {
        if (!orthoCamera) return;
        const aspect = window.innerWidth / window.innerHeight;
        const halfH = modelSpan * 0.7, halfW = halfH * aspect;
        orthoCamera.left = -halfW; orthoCamera.right = halfW;
        orthoCamera.top = halfH; orthoCamera.bottom = -halfH;
        if (cameraMode === 'orbit' && isOrthoOrbit) {
            const dir = new THREE.Vector3().subVectors(orbitCamera.position, orbitControls.target).normalize();
            orthoCamera.position.copy(orbitControls.target).addScaledVector(dir, modelSpan * 5);
            orthoCamera.lookAt(orbitControls.target);
        } else {
            orthoCamera.position.set(modelCenter.x, modelCenter.y + modelSpan * 5, modelCenter.z);
            orthoCamera.lookAt(modelCenter);
        }
        orthoCamera.updateProjectionMatrix();
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
        const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
        for (let h of [0.5, WALK_HEIGHT, WALK_HEIGHT * 0.8]) {
            const p = pos.clone(); p.y = pos.y - WALK_HEIGHT + h;
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
        orbitCamera.position.set(modelCenter.x + d * 1.4, modelCenter.y + d * 1.2, modelCenter.z + d * 1.4);
        orbitControls.target.copy(modelCenter);
        activeCamera = orbitCamera;
        orbitControls.object = activeCamera;
        orbitControls.update();
        if (cameraMode === 'ortho') syncOrthoCamera();
    }
    window.resetCamera = resetCamera;

    function buildMatSet(hexColor, layerName) {
        const lname = (layerName || '').toLowerCase();
        let ovr = null;
        Object.keys(LAYER_OVERRIDES).forEach(k => { if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k]; });
        const rendParams = ovr ? Object.assign({ side: THREE.DoubleSide }, ovr) : { color: hexColor, roughness: 0.72, metalness: 0.05, side: THREE.DoubleSide };
        rendParams.polygonOffset = true; rendParams.polygonOffsetFactor = 1; rendParams.polygonOffsetUnits = 1;
        return {
            rendered: new THREE.MeshStandardMaterial(rendParams),
            clay: new THREE.MeshStandardMaterial({ color: 0xd4c5b0, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide }),
            wireframe: new THREE.MeshStandardMaterial({ color: hexColor, wireframe: true, side: THREE.DoubleSide }),
            xray: new THREE.MeshStandardMaterial({ color: hexColor, transparent: true, opacity: 0.18, roughness: 0.3, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false })
        };
    }

    function applyStyle(style) {
        visualStyle = style;
        document.querySelectorAll('.style-btn').forEach(b => b.classList.toggle('active', b.dataset.style === style));
        if (!modelGroup) return;
        modelGroup.traverse(obj => {
            if (obj.isMesh && meshMatCache[obj.uuid]) obj.material = meshMatCache[obj.uuid][style] || meshMatCache[obj.uuid].rendered;
        });
    }
    window.applyStyle = applyStyle;

    function updateLayersUI() {
        const list = document.getElementById('layers-list');
        if (!list) return;
        list.innerHTML = '';
        const names = Object.keys(layerMeshes).sort();
        if (names.length === 0) {
            list.innerHTML = '<div style="font-size:0.65rem;color:#6b7280;padding:0.2rem">No layers found</div>';
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
            cb.type = 'checkbox'; cb.checked = true;
            cb.onchange = () => { if (layerMeshes[name]) layerMeshes[name].forEach(m => m.visible = cb.checked); };
            const track = document.createElement('span');
            track.className = 'toggle-track';
            lbl.appendChild(cb); lbl.appendChild(track);
            row.appendChild(span); row.appendChild(lbl);
            list.appendChild(row);
        });
    }

    function getObjAppearance(obj, doc) {
        let hexColor = 0xcccccc, layerName = 'Default';
        try {
            const attrs = obj.attributes();
            const layerIdx = attrs.layerIndex;
            const layers = doc.layers();
            if (layerIdx >= 0 && layers.count > 0) {
                const layer = layers.get(layerIdx);
                if (layer) {
                    layerName = layer.name || 'Default';
                    hexColor = (attrs.colorSource === 1 || attrs.colorSource === 'object') ? 
                        rhinoColorToHex(attrs.objectColor || attrs.drawColor) : rhinoColorToHex(layer.color);
                }
            }
        } catch(e) {}
        return { hexColor, layerName };
    }

    function rhinoColorToHex(rc) {
        if (!rc) return 0xcccccc;
        const r = rc.r !== undefined ? rc.r : (rc[0] || 0), g = rc.g !== undefined ? rc.g : (rc[1] || 0), b = rc.b !== undefined ? rc.b : (rc[2] || 0);
        return (r << 16) | (g << 8) | b;
    }

    function rhinoGeomToThreeObjs(geom, rhino, appearance) {
        const results = [], hex = appearance.hexColor, lname = appearance.layerName;
        if (typeof geom.toThreejsJSON === 'function') {
            try {
                const json = geom.toThreejsJSON();
                const geo = new THREE.BufferGeometryLoader().parse(typeof json === 'string' ? JSON.parse(json) : json);
                const matSet = buildMatSet(hex, lname);
                const mesh = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
                meshMatCache[mesh.uuid] = matSet; results.push(mesh); return results;
            } catch(e) {}
        }
        if (typeof geom.getMesh === 'function') {
            const types = [rhino.MeshType.Any, rhino.MeshType.Render, rhino.MeshType.Default];
            for (let t of types) {
                try {
                    const rm = geom.getMesh(t);
                    if (rm) {
                        const geo = new THREE.BufferGeometryLoader().parse(JSON.parse(rm.toThreejsJSON()));
                        const matSet = buildMatSet(hex, lname);
                        const mesh = new THREE.Mesh(geo, matSet[visualStyle] || matSet.rendered);
                        meshMatCache[mesh.uuid] = matSet; results.push(mesh); rm.delete(); return results;
                    }
                } catch(e) {}
            }
        }
        if (geom.domain && typeof geom.pointAt === 'function') {
            const pts = [], d = geom.domain;
            for (let i = 0; i <= 100; i++) {
                const p = geom.pointAt(d[0] + (d[1] - d[0]) * (i / 100));
                pts.push(new THREE.Vector3(p[0], p[1], p[2]));
            }
            results.push(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({color:hex})));
        }
        return results;
    }

    function processDocObjects(doc, rhino, shadowEnabled) {
        const group = new THREE.Group();
        const objs = doc.objects();
        layerMeshes = {};
        function recurse(obj, parent) {
            const geom = obj.geometry(); if (!geom) return;
            if (rhino.ObjectType && geom.objectType === rhino.ObjectType.InstanceReference) {
                const idef = doc.instanceDefinitions().findId(geom.parentIdefId);
                if (idef) {
                    const bg = new THREE.Group();
                    idef.getObjectIds().forEach(id => { const c = doc.objects().findId(id); if (c) recurse(c, bg); });
                    bg.applyMatrix4(new THREE.Matrix4().fromArray(geom.xform.toArray()));
                    parent.add(bg);
                }
            } else {
                const app = getObjAppearance(obj, doc);
                const tojs = rhinoGeomToThreeObjs(geom, rhino, app);
                tojs.forEach(o => {
                    if (o.isMesh) o.castShadow = o.receiveShadow = shadowEnabled;
                    parent.add(o);
                    const ln = app.layerName || 'Default';
                    if (!layerMeshes[ln]) layerMeshes[ln] = [];
                    layerMeshes[ln].push(o);
                });
            }
        }
        for (let i = 0; i < objs.count; i++) recurse(objs.get(i), group);
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
                const res = await fetch(filePath);
                if (!res.ok) throw new Error('Model not found');
                const doc = rhino.File3dm.fromByteArray(new Uint8Array(await res.arrayBuffer()));
                const group = processDocObjects(doc, rhino, document.getElementById('toggle-shadows').checked);
                doc.delete();
                if (group.children.length === 0) throw new Error('No geometry found');
                group.rotation.x = -Math.PI / 2;
                scene.add(group); modelGroup = group;
                const box = new THREE.Box3().setFromObject(group);
                box.getCenter(modelCenter); box.getSize(modelSize);
                modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;
                group.position.y += -box.min.y; modelCenter.y += -box.min.y;
                groundMeshes = []; group.traverse(c => { if (c.isMesh) groundMeshes.push(c); });
                is2DModel = groundMeshes.length === 0;
                resetCamera(); syncOrthoCamera();
                setCameraMode(is2DModel ? 'ortho' : 'orbit');
                updateLayersUI(); applyStyle(visualStyle); updateSun(); hideLoading();

                applyUIConfig(config);

            } catch(e) { console.error(e); showLoading('Error: ' + e.message); }
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
            console.warn("Config not available:", e);
            return null;
        }
    }

    function applyUIConfig(config) {
        if (!config) return;

        if (Array.isArray(config.cameraModes)) {
            document.querySelectorAll('.cam-btn[data-mode]').forEach(btn => {
                if (!config.cameraModes.includes(btn.dataset.mode)) btn.style.display = 'none';
            });
        }

        if (Array.isArray(config.visualStyles)) {
            document.querySelectorAll('.style-btn[data-style]').forEach(btn => {
                if (!config.visualStyles.includes(btn.dataset.style)) btn.style.display = 'none';
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
        renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
        renderer.setPixelRatio(window.devicePixelRatio); renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
        renderer.outputEncoding = THREE.sRGBEncoding;
        document.body.appendChild(renderer.domElement);

        const aspect = window.innerWidth / window.innerHeight;
        orbitCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000000);
        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true; orbitControls.dampingFactor = 0.08;
        walkCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000); walkCamera.rotation.order = 'YXZ';
        flyCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000000); flyCamera.rotation.order = 'YXZ';
        orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);
        activeCamera = orbitCamera;

        scene.add(new THREE.HemisphereLight(0xd6e4f0, 0x3a3020, 0.65));
        sun = new THREE.DirectionalLight(0xfff5e0, 1.2); sun.castShadow = true;
        sun.shadow.mapSize.width = sun.shadow.mapSize.height = 2048;
        scene.add(sun); scene.add(sun.target);
        fill = new THREE.DirectionalLight(0x8899cc, 0.3); fill.position.set(-5, 2, -5); scene.add(fill);

        window.addEventListener('resize', () => {
            renderer.setSize(window.innerWidth, window.innerHeight);
            const a = window.innerWidth / window.innerHeight;
            orbitCamera.aspect = walkCamera.aspect = flyCamera.aspect = a;
            orbitCamera.updateProjectionMatrix(); walkCamera.updateProjectionMatrix(); flyCamera.updateProjectionMatrix();
            syncOrthoCamera();
        });

        window.addEventListener('keydown', e => {
            keys[e.code] = true;
            if (e.code === 'Digit1') setCameraMode('orbit');
            if (e.code === 'Digit2') setCameraMode('walk');
            if (e.code === 'Digit3') setCameraMode('fly');
            if (e.code === 'Digit4') setCameraMode('ortho');
            if (e.code === 'KeyR') resetCamera();
        });
        window.addEventListener('keyup', e => keys[e.code] = false);

        window.addEventListener('mousemove', e => {
            if ((cameraMode !== 'walk' && cameraMode !== 'fly') || document.pointerLockElement !== renderer.domElement) return;
            yaw -= e.movementX * 0.002; pitch -= e.movementY * 0.002;
            pitch = Math.max(-Math.PI/2+0.1, Math.min(Math.PI/2-0.1, pitch));
            if (cameraMode === 'walk') walkCamera.rotation.set(pitch, yaw, 0, 'YXZ'); else flyCamera.rotation.set(pitch, yaw, 0, 'YXZ');
        });

        renderer.domElement.addEventListener('click', () => { if (cameraMode==='walk'||cameraMode==='fly') renderer.domElement.requestPointerLock(); });
        document.getElementById('sun-az').addEventListener('input', updateSun);
        document.getElementById('sun-el').addEventListener('input', updateSun);
        document.getElementById('toggle-shadows').addEventListener('change', e => toggleShadows(e.target.checked));
        document.getElementById('bg-select').addEventListener('change', e => changeBackground(e.target.value));
        document.getElementById('ortho-toggle').addEventListener('click', toggleOrtho);
        document.querySelectorAll('.cam-btn[data-mode]').forEach(btn => btn.addEventListener('click', () => setCameraMode(btn.dataset.mode)));
        document.querySelectorAll('.style-btn').forEach(btn => btn.addEventListener('click', () => applyStyle(btn.dataset.style)));

        changeBackground('black');
        loadModel();

        (function anim() {
            requestAnimationFrame(anim);
            const spd = modelSpan * 0.004, rad = 0.5;
            if (cameraMode === 'walk') {
                const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), m = new THREE.Vector3();
                if (keys['KeyW']) m.add(f); if (keys['KeyS']) m.addScaledVector(f,-1); if (keys['KeyA']) m.addScaledVector(r,-1); if (keys['KeyD']) m.add(r);
                if (m.lengthSq()>0) velocity.addScaledVector(m.normalize(), spd); velocity.multiplyScalar(damping);
                const next = walkCamera.position.clone().add(velocity); next.y = getGroundY(next.x, next.z) + WALK_HEIGHT;
                if (!checkCollision(next, rad)) walkCamera.position.copy(next); else velocity.set(0,0,0);
            } else if (cameraMode === 'fly') {
                const f = new THREE.Vector3(), r = new THREE.Vector3(); flyCamera.getWorldDirection(f); r.crossVectors(f, flyCamera.up).normalize();
                const m = new THREE.Vector3(); if (keys['KeyW']) m.add(f); if (keys['KeyS']) m.addScaledVector(f,-1); if (keys['KeyA']) m.addScaledVector(r,-1); if (keys['KeyD']) m.add(r);
                if (keys['Space']) m.y += 1; if (keys['ShiftLeft']) m.y -= 1;
                if (m.lengthSq()>0) velocity.addScaledVector(m.normalize(), spd); velocity.multiplyScalar(damping);
                const next = flyCamera.position.clone().add(velocity); if (!checkCollision(next, rad)) flyCamera.position.copy(next); else velocity.set(0,0,0);
            } else if (cameraMode === 'orbit') orbitControls.update();
            renderer.render(scene, activeCamera);
        })();
    }
    init();
})();
