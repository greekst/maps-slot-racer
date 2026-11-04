// Mapbox custom layer that renders the car (and ghost) with Three.js.
//
// Why a custom layer instead of a Mapbox `model` layer fed by GeoJSON setData:
// setData is processed asynchronously in a worker, so the model lags the camera
// by a frame or more (visible jitter). A custom layer reads the car pose at draw
// time, in the same frame and with the same matrix as the map camera.
//
// Precision: the scene is re-anchored at the car every frame, so all Three.js
// coordinates are small numbers in metres. The mercator transform is composed
// in float64 on the CPU before upload.

import * as THREE from 'three';
import mapboxgl from 'mapbox-gl';
import { skyScene } from './sky-env.js';

// Three's fog uses view-space depth; our view matrix carries no rotation (Mapbox's
// projection does), so use true eye distance instead.
THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\n\tvFogDepth = length( mvPosition.xyz );\n#endif';

const SHADOW_EXTENT = 110;     // m half-width of the sun's shadow camera around the car
const QUALITY = { high: { shadow: 4096, props: true }, medium: { shadow: 2048, props: true }, low: { shadow: 0, props: false } };
import { buildCar, poseCar } from './car-model.js';

const LIGHTING = {
    day:   { hemi: 2.6, hemiSky: '#e4f0ff', hemiGround: '#7a7266', sun: 3.2, sunColor: '#fff6e6', env: 1.0, night: false, lights: 0, sunDir: [180, 20], shadow: 0.42, fog: ['#dbe6f0', 350, 3200] },
    dawn:  { hemi: 2.0, hemiSky: '#ffdcc8', hemiGround: '#4a3f3a', sun: 2.4, sunColor: '#ffc7a0', env: 0.9, night: false, lights: 0.35, sunDir: [120, 50], shadow: 0.35, fog: ['#e9b9a4', 300, 2800] },
    dusk:  { hemi: 1.8, hemiSky: '#ffc2a8', hemiGround: '#3a3044', sun: 2.0, sunColor: '#ffab78', env: 0.9, night: true, lights: 0.7, sunDir: [240, 80], shadow: 0.3, fog: ['#c98f86', 300, 2600] },
    night: { hemi: 1.5, hemiSky: '#8a9bd0', hemiGround: '#22222e', sun: 0.9, sunColor: '#a9bcff', env: 0.8, night: true, lights: 1, sunDir: [270, 20], shadow: 0.18, fog: ['#1a2242', 250, 2400] },
};

export class CarLayer {
    constructor({ track, getCar, getGhost, getCamera }) {
        this.id = 'car-3d';
        this.type = 'custom';
        this.renderingMode = '3d';
        this.track = track;
        this.getCar = getCar;
        this.getGhost = getGhost;
        this.getCamera = getCamera;
        this.env = LIGHTING.dusk;
        this._m = new THREE.Matrix4();
        this._l = new THREE.Matrix4();
        this.lightListeners = [];
        this.frameListeners = [];
        this._right = new THREE.Vector3(); this._up = new THREE.Vector3(); this._fwd = new THREE.Vector3();
    }

    setLightPreset(name) {
        this.presetName = LIGHTING[name] ? name : 'dusk';
        this.env = LIGHTING[this.presetName];
        this.envDirty = true;
        if (!this.scene) return;
        this.hemi.intensity = this.env.hemi;
        this.hemi.color.set(this.env.hemiSky);
        this.hemi.groundColor.set(this.env.hemiGround);
        this.sun.intensity = this.env.sun;
        this.sun.color.set(this.env.sunColor);
        // Mapbox light direction: azimuth clockwise from north, polar angle from zenith
        const [az, pol] = this.env.sunDir.map(d => d * Math.PI / 180);
        this.sunVec = new THREE.Vector3(Math.sin(az) * Math.sin(pol), Math.cos(az) * Math.sin(pol), Math.cos(pol));
        this.shadowCatcher.material.opacity = this.env.shadow;
        this.scene.fog.color.set(this.env.fog[0]);
        this.scene.fog.near = this.env.fog[1];
        this.scene.fog.far = this.env.fog[2];
        this.scene.environmentIntensity = this.env.env;
        for (const fn of this.lightListeners) fn(this.env);
    }

    // Graphics quality: 'high' (4K shadows, props), 'medium' (2K shadows), 'low' (no shadows/props)
    setQuality(level) {
        this.quality = QUALITY[level] ? level : 'high';
        if (!this.sun) return this.quality;
        const q = QUALITY[this.quality];
        this.sun.castShadow = q.shadow > 0;
        this.shadowCatcher.visible = q.shadow > 0;
        if (q.shadow && this.sun.shadow.mapSize.x !== q.shadow) {
            this.sun.shadow.mapSize.set(q.shadow, q.shadow);
            this.sun.shadow.map?.dispose();
            this.sun.shadow.map = null;
        }
        const props = this.world.getObjectByName('props');
        if (props) props.visible = q.props;
        this.map?.triggerRepaint();
        return this.quality;
    }

    // World-anchored content (city, street furniture) in track metres.
    // `onLight(env)` is called on every light-preset change.
    // `onFrame({ right, up, t, cam })` runs before each draw (billboards, animation).
    addWorld(obj, onLight, onFrame) {
        this.world.add(obj);
        if (obj.name === 'props') obj.visible = (QUALITY[this.quality] || QUALITY.high).props;
        if (onLight) { this.lightListeners.push(onLight); onLight(this.env); }
        if (onFrame) this.frameListeners.push(onFrame);
        this.map?.triggerRepaint();
    }

    onAdd(map, gl) {
        this.map = map;
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();

        // Scene world frame: x = East, y = North, z = up (metres, relative to the car).
        // Mercator y points South; that flip lives in the projection matrix (see render()),
        // NOT in the scene graph — Mapbox's matrix already mirrors handedness, and a second
        // mirror in an object matrix makes Three invert its face culling (you see the inside).
        this.root = new THREE.Group();
        this.scene.add(this.root);

        this.hemi = new THREE.HemisphereLight('#ffffff', '#444444', 1);
        this.hemi.up.set(0, 0, 1);
        this.hemi.position.set(0, 0, 1);
        this.root.add(this.hemi);
        this.sun = new THREE.DirectionalLight('#ffffff', 1);
        this.sun.position.set(-30, 40, 60);
        this.sun.castShadow = true;
        const sc = this.sun.shadow.camera;
        sc.left = sc.bottom = -SHADOW_EXTENT; sc.right = sc.top = SHADOW_EXTENT;
        sc.near = 1; sc.far = 900;
        this.sun.shadow.mapSize.set(4096, 4096);
        this.sun.shadow.bias = -0.0004;
        this.sun.shadow.normalBias = 0.04;
        this.root.add(this.sun);
        this.root.add(this.sun.target);
        this.sunVec = new THREE.Vector3(0, 0, 1);
        this.scene.fog = new THREE.Fog('#dbe6f0', 300, 3000);

        // Mapbox draws the ground, so shadows land on an invisible catcher plane that only darkens
        this.shadowCatcher = new THREE.Mesh(
            new THREE.PlaneGeometry(SHADOW_EXTENT * 2.2, SHADOW_EXTENT * 2.2),
            new THREE.ShadowMaterial({ opacity: 0.4, depthWrite: false, color: '#1a1f2e', fog: false }),
        );
        this.shadowCatcher.position.z = 0.03;
        this.shadowCatcher.receiveShadow = true;
        this.shadowCatcher.renderOrder = -1;
        this.root.add(this.shadowCatcher);

        // First object of the main (colour) pass: restores Mapbox's depth range after the
        // shadow pass, which Three renders inside the same render() call.
        const hookGeo = new THREE.BufferGeometry();
        hookGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
        const hook = new THREE.Mesh(hookGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
        hook.frustumCulled = false;
        hook.renderOrder = -1e9;
        hook.onBeforeRender = () => { if (this.depthRange) gl.depthRange(this.depthRange[0], this.depthRange[1]); };
        this.scene.add(hook);

        this.car = buildCar({ paint: '#d7141a' });
        this.ghost = buildCar({ ghost: true });
        this.ghost.visible = false;
        this.car.traverse(o => { if (o.isMesh && !o.material.transparent) o.castShadow = true; });
        this.root.add(this.car, this.ghost);
        this.world = new THREE.Group();
        this.world.name = 'world';
        this.root.add(this.world);

        this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
        this.renderer.setPixelRatio(1);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // The sky environment is Y-up; our world is Z-up (mercator, y south). Stand it upright.
        this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
        this.setLightPreset(this.presetName || 'dusk');
        this.rebuildEnv(gl);
        this.setQuality(this.quality || 'high');
    }

    // (Re)build the image-based lighting from the procedural sky for the current preset
    rebuildEnv(gl) {
        this.envDirty = false;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const old = this.scene.environment;
        this.scene.environment = pmrem.fromScene(skyScene(this.presetName), 0).texture;
        old?.dispose();
        pmrem.dispose();
        this.renderer.setRenderTarget(null);
        this.renderer.resetState();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    render(gl, matrix) {
        if (this.envDirty) this.rebuildEnv(gl);
        const car = this.getCar();
        const cam = this.getCamera();
        const proj = this.track.proj;

        // Anchor the Three.js world at the car's ground point
        const [lng, lat] = proj.toLngLat(car.x, car.y);
        const merc = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0);
        const s = merc.meterInMercatorCoordinateUnits();

        this.car.position.set(0, 0, 0);
        this.world.position.set(-car.x, -car.y, 0);
        // Shadow camera follows the car, snapped to whole shadow texels so edges don't swim
        const texel = (2 * SHADOW_EXTENT) / this.sun.shadow.mapSize.x;
        const sx = Math.round(car.x / texel) * texel - car.x, sy = Math.round(car.y / texel) * texel - car.y;
        this.sun.target.position.set(sx, sy, 0);
        this.sun.position.set(sx + this.sunVec.x * 400, sy + this.sunVec.y * 400, this.sunVec.z * 400);
        this.shadowCatcher.position.set(sx, sy, 0.03);
        poseCar(this.car, car, this.env);
        this.car.visible = car.opacity > 0.01 && !cam.hideCar;

        const ghost = this.getGhost();
        this.ghost.visible = !!ghost;
        if (ghost) {
            this.ghost.position.set(ghost.x - car.x, ghost.y - car.y, 0);
            poseCar(this.ghost, ghost, this.env);
        }

        // Camera eye in scene coords so lighting/reflections use the real view vector
        const ex = cam.x - car.x, ey = cam.y - car.y, ez = cam.z;
        this.camera.position.set(ex, ey, ez);
        if (this.frameListeners.length) {
            const b = (cam.bearingDeg ?? 0) * Math.PI / 180, p = (cam.pitchDeg ?? 60) * Math.PI / 180;
            this._fwd.set(Math.sin(b) * Math.sin(p), Math.cos(b) * Math.sin(p), -Math.cos(p));
            this._right.set(Math.cos(b), -Math.sin(b), 0);
            this._up.crossVectors(this._right, this._fwd);
            const frame = { right: this._right, up: this._up, t: performance.now() / 1000, cam };
            for (const fn of this.frameListeners) fn(frame);
        }
        this.camera.updateMatrixWorld(true);

        this._m.fromArray(matrix);
        this._l.makeTranslation(merc.x, merc.y, merc.z)
            .scale(new THREE.Vector3(s, -s, s))
            .multiply(new THREE.Matrix4().makeTranslation(ex, ey, ez));
        this.camera.projectionMatrix.copy(this._m).multiply(this._l);
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

        // Three caches its own viewport; keep it matched to Mapbox's drawing buffer, and
        // restore GL state afterwards so Mapbox's state cache stays truthful.
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        this.renderer.resetState();
        this.renderer.setViewport(0, 0, w, h);
        // Mapbox gives 3D layers a compressed depth range (e.g. [0, 0.96]). The shadow pass
        // must write the full range or every comparison passes (no shadows); the main pass
        // must keep Mapbox's range to sort against its trees. The hook switches between them.
        this.depthRange = gl.getParameter(gl.DEPTH_RANGE);
        gl.depthRange(0, 1);
        this.renderer.render(this.scene, this.camera);
        gl.depthRange(this.depthRange[0], this.depthRange[1]);
        this.renderer.resetState();
        gl.viewport(0, 0, w, h);
        // Three leaves pixel-store flags set after texture uploads; Mapbox's 3D LUT upload rejects them
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
}
