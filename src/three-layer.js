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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildCar, poseCar } from './car-model.js';

const LIGHTING = {
    day:   { hemi: 2.6, hemiSky: '#e4f0ff', hemiGround: '#7a7266', sun: 3.2, sunColor: '#fff6e6', env: 0.35, night: false },
    dawn:  { hemi: 2.0, hemiSky: '#ffdcc8', hemiGround: '#4a3f3a', sun: 2.4, sunColor: '#ffc7a0', env: 0.25, night: false },
    dusk:  { hemi: 1.8, hemiSky: '#ffc2a8', hemiGround: '#3a3044', sun: 2.0, sunColor: '#ffab78', env: 0.2, night: true },
    night: { hemi: 1.5, hemiSky: '#8a9bd0', hemiGround: '#22222e', sun: 0.9, sunColor: '#a9bcff', env: 0.1, night: true },
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
    }

    setLightPreset(name) {
        this.env = LIGHTING[name] || LIGHTING.dusk;
        if (!this.scene) return;
        this.hemi.intensity = this.env.hemi;
        this.hemi.color.set(this.env.hemiSky);
        this.hemi.groundColor.set(this.env.hemiGround);
        this.sun.intensity = this.env.sun;
        this.sun.color.set(this.env.sunColor);
        this.scene.environmentIntensity = this.env.env;
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
        this.root.add(this.sun);
        this.root.add(this.sun.target);

        this.car = buildCar({ paint: '#d7141a' });
        this.ghost = buildCar({ ghost: true });
        this.ghost.visible = false;
        this.root.add(this.car, this.ghost);

        this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
        this.renderer.setPixelRatio(1);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;

        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        // RoomEnvironment is Y-up; our world is Z-up (mercator, y south). Stand it upright.
        this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
        pmrem.dispose();
        this.renderer.setRenderTarget(null);
        this.renderer.resetState();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

        this.setLightPreset(this.presetName || 'dusk');
    }

    render(gl, matrix) {
        const car = this.getCar();
        const cam = this.getCamera();
        const proj = this.track.proj;

        // Anchor the Three.js world at the car's ground point
        const [lng, lat] = proj.toLngLat(car.x, car.y);
        const merc = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0);
        const s = merc.meterInMercatorCoordinateUnits();

        this.car.position.set(0, 0, 0);
        poseCar(this.car, car, this.env);
        this.car.visible = car.opacity > 0.01;

        const ghost = this.getGhost();
        this.ghost.visible = !!ghost;
        if (ghost) {
            this.ghost.position.set(ghost.x - car.x, ghost.y - car.y, 0);
            poseCar(this.ghost, ghost, this.env);
        }

        // Camera eye in scene coords so lighting/reflections use the real view vector
        const ex = cam.x - car.x, ey = cam.y - car.y, ez = cam.z;
        this.camera.position.set(ex, ey, ez);
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
        this.renderer.render(this.scene, this.camera);
        this.renderer.resetState();
        gl.viewport(0, 0, w, h);
        // Three leaves pixel-store flags set after texture uploads; Mapbox's 3D LUT upload rejects them
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
}
