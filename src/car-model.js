// Procedural low-poly GT car, built in real metres.
// Local frame: +X = right, +Y = forward (nose), +Z = up. Origin = ground under the car's centre.
// Because we build it ourselves there is no mystery mesh orientation: yaw = -heading.

import * as THREE from 'three';

const LEN = 4.66, WIDTH = 1.94, WHEEL_R = 0.34, WHEEL_W = 0.28;
const AXLE_F = 1.38, AXLE_R = -1.30, TRACK_HALF = 0.83;

// Maps an extrusion built in (forward, up, across) into car space (x=across, y=forward, z=up).
const PROFILE_TO_CAR = new THREE.Matrix4().set(
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
);

function extrudeProfile(points, width, bevel = 0.05) {
    const shape = new THREE.Shape(points.map(([f, u]) => new THREE.Vector2(f, u)));
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel,
        bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 3, curveSegments: 8, steps: 1,
    });
    geo.translate(0, 0, -(width - bevel * 2) / 2);
    geo.applyMatrix4(PROFILE_TO_CAR);
    geo.computeVertexNormals();
    return geo;
}

function blobShadowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.75)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
}

function beamTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 256, 4, 64, 150, 150);
    grd.addColorStop(0, 'rgba(255,244,214,0.9)');
    grd.addColorStop(0.5, 'rgba(255,240,200,0.28)');
    grd.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 256);
    return new THREE.CanvasTexture(c);
}

export function buildCar({ paint = '#d7141a', ghost = false } = {}) {
    const root = new THREE.Group();       // yaw + position
    const tilt = new THREE.Group();       // body roll / pitch
    root.add(tilt);

    const mats = ghost ? ghostMaterials() : solidMaterials(paint);

    // ── Body ────────────────────────────────────────────────────────────────
    const lower = extrudeProfile([
        [-2.30, 0.20], [-2.35, 0.50], [-2.28, 0.78], [-1.45, 0.86], [0.85, 0.86],
        [1.70, 0.73], [2.22, 0.56], [2.33, 0.36], [2.24, 0.18], [1.70, 0.14],
        [-1.80, 0.14],
    ], WIDTH, 0.07);
    tilt.add(new THREE.Mesh(lower, mats.paint));

    const cabin = extrudeProfile([
        [-1.55, 0.84], [-0.95, 1.17], [0.10, 1.21], [0.92, 0.84],
    ], 1.56, 0.06);
    tilt.add(new THREE.Mesh(cabin, mats.glass));

    const roof = extrudeProfile([
        [-0.86, 1.155], [0.05, 1.19], [0.07, 1.235], [-0.88, 1.20],
    ], 1.36, 0.02);
    tilt.add(new THREE.Mesh(roof, mats.paint));

    // Racing stripes along the hood/roof/deck
    const stripe = extrudeProfile([
        [-2.29, 0.795], [-1.45, 0.875], [0.85, 0.875], [1.70, 0.745], [2.23, 0.575],
        [2.23, 0.55], [1.70, 0.725], [0.85, 0.855], [-1.45, 0.855], [-2.29, 0.775],
    ], 0.34, 0);
    tilt.add(new THREE.Mesh(stripe, mats.stripe));

    // Splitter + side skirts + diffuser
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.98, 0.28, 0.04), mats.carbon);
    splitter.position.set(0, 2.24, 0.14);
    tilt.add(splitter);
    for (const sx of [-1, 1]) {
        const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.1, 0.12), mats.carbon);
        skirt.position.set(sx * 0.99, 0.02, 0.2);
        tilt.add(skirt);
    }

    // Rear wing
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.34, 0.035), mats.carbon);
    wing.position.set(0, -2.06, 1.13);
    wing.rotation.x = -0.12;
    tilt.add(wing);
    for (const sx of [-1, 1]) {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.2), mats.carbon);
        plate.position.set(sx * 0.92, -2.06, 1.10);
        tilt.add(plate);
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.34), mats.carbon);
        strut.position.set(sx * 0.45, -2.02, 0.94);
        tilt.add(strut);
    }

    // ── Lights ──────────────────────────────────────────────────────────────
    for (const sx of [-1, 1]) {
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.07), mats.headlight);
        head.position.set(sx * 0.62, 2.18, 0.58);
        head.rotation.x = -0.35;
        tilt.add(head);
    }
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.05, 0.07), mats.taillight);
    tail.position.set(0, -2.34, 0.66);
    tilt.add(tail);

    // ── Wheels ──────────────────────────────────────────────────────────────
    const tyreGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 24);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(WHEEL_R * 0.68, WHEEL_R * 0.68, WHEEL_W + 0.012, 10);
    rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(WHEEL_W + 0.02, WHEEL_R * 1.25, 0.05);

    const wheels = [];
    const steerPivots = [];
    for (const [ay, front] of [[AXLE_F, true], [AXLE_R, false]]) {
        for (const sx of [-1, 1]) {
            const steer = new THREE.Group();
            steer.position.set(sx * TRACK_HALF, ay, WHEEL_R);
            const spin = new THREE.Group();
            spin.add(new THREE.Mesh(tyreGeo, mats.tyre));
            spin.add(new THREE.Mesh(rimGeo, mats.rim));
            for (let k = 0; k < 3; k++) {
                const sp = new THREE.Mesh(spokeGeo, mats.rim);
                sp.rotation.x = k * Math.PI / 3;
                spin.add(sp);
            }
            steer.add(spin);
            root.add(steer);          // wheels don't roll with the body
            wheels.push(spin);
            if (front) steerPivots.push(steer);
        }
    }

    // ── Ground effects: blob shadow + headlight pools ───────────────────────
    const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(WIDTH * 1.35, LEN * 1.15),
        new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: ghost ? 0 : 0.9 }),
    );
    shadow.position.z = 0.03;
    shadow.renderOrder = -1;
    root.add(shadow);

    const beams = new THREE.Mesh(
        new THREE.PlaneGeometry(7, 16),
        new THREE.MeshBasicMaterial({ map: beamTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }),
    );
    beams.position.set(0, 2.2 + 8, 0.04);
    root.add(beams);

    root.userData = { tilt, wheels, steerPivots, mats, shadow, beams, ghost };
    return root;
}

// Apply a SlotCar-like pose to a built car. Position is handled by the caller.
export function poseCar(obj, pose, env) {
    const { tilt, wheels, steerPivots, mats, beams, shadow, ghost } = obj.userData;
    obj.rotation.set(0, 0, -pose.heading);
    obj.position.z = pose.z || 0;
    tilt.rotation.set(-(pose.pitch || 0), -(pose.roll || 0), 0, 'YXZ');
    for (const w of wheels) w.rotation.x = -(pose.wheelAngle || 0);
    for (const p of steerPivots) p.rotation.z = -(pose.steer || 0);
    if (!ghost) {
        const braking = (pose.brake || 0) > 0.05;
        mats.taillight.emissiveIntensity = braking ? 6 : (env.night ? 1.6 : 0.6);
        mats.headlight.emissiveIntensity = env.night ? 5 : 1.2;
        beams.material.opacity = env.night ? 0.55 * (pose.opacity ?? 1) : 0;
        shadow.material.opacity = 0.9 * (pose.opacity ?? 1) * Math.max(0, 1 - (pose.z || 0) / 2);
        const op = pose.opacity ?? 1;
        const fading = op < 0.999;
        for (const m of mats.all) {
            m.transparent = fading || m.userData.baseTransparent;
            m.opacity = (m.userData.baseOpacity ?? 1) * op;
            m.depthWrite = !fading;
        }
    }
}

function tag(m) { m.userData.baseOpacity = m.opacity; m.userData.baseTransparent = m.transparent; return m; }

function solidMaterials(paint) {
    const m = {
        paint: new THREE.MeshPhysicalMaterial({ color: paint, metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
        stripe: new THREE.MeshPhysicalMaterial({ color: '#f5f5f0', metalness: 0.2, roughness: 0.35, clearcoat: 1 }),
        glass: new THREE.MeshPhysicalMaterial({ color: '#0b1016', metalness: 0.6, roughness: 0.06, clearcoat: 1 }),
        carbon: new THREE.MeshStandardMaterial({ color: '#15171a', metalness: 0.3, roughness: 0.55 }),
        tyre: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92 }),
        rim: new THREE.MeshStandardMaterial({ color: '#b9bec6', metalness: 0.9, roughness: 0.28 }),
        headlight: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4dc', emissiveIntensity: 1.2 }),
        taillight: new THREE.MeshStandardMaterial({ color: '#400000', emissive: '#ff1a1a', emissiveIntensity: 0.6 }),
    };
    m.all = Object.values(m).map(tag);
    return m;
}

function ghostMaterials() {
    const g = new THREE.MeshBasicMaterial({ color: '#5ee7ff', transparent: true, opacity: 0.28, depthWrite: false });
    const edge = new THREE.MeshBasicMaterial({ color: '#b8f6ff', transparent: true, opacity: 0.4, depthWrite: false });
    const m = { paint: g, stripe: edge, glass: g, carbon: g, tyre: g, rim: edge, headlight: edge, taillight: edge };
    m.all = [g, edge];
    return m;
}
