// Procedural low-poly GT car, built in real metres.
// Local frame: +X = right, +Y = forward (nose), +Z = up. Origin = ground under the car's centre.
// Because we build it ourselves there is no mystery mesh orientation: yaw = -heading.

import * as THREE from 'three';

const LEN = 4.66, WIDTH = 1.94, WHEEL_R = 0.34, WHEEL_W = 0.28;
const AXLE_F = 1.38, AXLE_R = -1.30, TRACK_HALF = 0.83;

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

// ── Lofted body ─────────────────────────────────────────────────────────────
// A section is described at station y (m, +nose) by: half-width, bottom z, top z,
// superellipse exponent (higher = boxier) and tumblehome (how much the top pulls in).
// Values are piecewise-linear in y between the listed stations.
const BODY = {
    y:    [-2.33, -2.29, -2.0, -1.62, -1.30, -0.95, 0.0,  0.95, 1.38, 1.75, 2.10, 2.30, 2.34],
    hw:   [0.88,  0.93,  0.96, 0.985, 1.0,   0.975, 0.955, 0.97, 1.0,  0.985, 0.93, 0.80, 0.70],
    bot:  [0.26,  0.18,  0.15, 0.15,  0.15,  0.14,  0.14,  0.14, 0.15, 0.15,  0.16, 0.22, 0.30],
    top:  [0.74,  0.80,  0.82, 0.84,  0.86,  0.86,  0.86,  0.85, 0.80, 0.73,  0.60, 0.46, 0.38],
    n:    [5.0,   4.6,   4.0,  3.8,   3.8,   3.8,   3.8,   3.8,  3.8,  3.6,   3.2,  2.8,  2.6],
    tuck: [0.10,  0.12,  0.14, 0.16,  0.16,  0.17,  0.17,  0.16, 0.15, 0.14,  0.12, 0.10, 0.10],
};
const GREENHOUSE = {
    y:    [-1.58, -1.30, -0.95, 0.0,  0.40, 0.95],
    hw:   [0.66,  0.72,  0.74,  0.76, 0.76, 0.74],
    bot:  [0.80,  0.80,  0.80,  0.80, 0.80, 0.80],
    top:  [0.84,  1.06,  1.18,  1.21, 1.08, 0.84],
    n:    [3.0,   3.0,   3.0,   3.0,  3.0,  3.0],
    tuck: [0.30,  0.30,  0.30,  0.30, 0.30, 0.30],
};
const ROOF = {
    y:    [-0.92, -0.5, 0.0, 0.12],
    hw:   [0.66,  0.69, 0.69, 0.67],
    bot:  [1.08,  1.12, 1.14, 1.12],
    top:  [1.185, 1.215, 1.225, 1.20],
    n:    [3.0,   3.0,  3.0,  3.0],
    tuck: [0.32,  0.32, 0.32, 0.32],
};

function sample(P, key, y) {
    const Y = P.y, V = P[key];
    if (y <= Y[0]) return V[0];
    for (let i = 1; i < Y.length; i++) {
        if (y <= Y[i]) {
            const t = (y - Y[i - 1]) / (Y[i] - Y[i - 1]);
            const s = t * t * (3 - 2 * t);         // smoothstep between stations
            return V[i - 1] + (V[i] - V[i - 1]) * s;
        }
    }
    return V[V.length - 1];
}

// Point on the section at angle a (0 = right side, π/2 = top)
function sectionPoint(P, y, a) {
    const hw = sample(P, 'hw', y), bot = sample(P, 'bot', y), top = sample(P, 'top', y);
    const n = sample(P, 'n', y), tuck = sample(P, 'tuck', y);
    const c = Math.cos(a), s = Math.sin(a);
    const ex = 2 / n;
    let x = Math.sign(c) * Math.abs(c) ** ex * hw;
    const z = (bot + top) / 2 + Math.sign(s) * Math.abs(s) ** ex * (top - bot) / 2;
    if (s > 0) x *= 1 - tuck * s * s;            // tumblehome: the upper half leans in
    return [x, y, z];
}

function loft(P, y0, y1, nY, nA) {
    const pos = [], idx = [];
    for (let i = 0; i <= nY; i++) {
        const y = y0 + (y1 - y0) * i / nY;
        for (let j = 0; j < nA; j++) pos.push(...sectionPoint(P, y, j / nA * Math.PI * 2));
    }
    for (let i = 0; i < nY; i++) for (let j = 0; j < nA; j++) {
        const a = i * nA + j, b = i * nA + (j + 1) % nA, c = a + nA, d = b + nA;
        idx.push(a, d, b, a, c, d);         // outward-facing (CCW seen from outside)
    }
    // end caps (fans around the section centroid)
    for (const [i, flip] of [[0, false], [nY, true]]) {
        const y = y0 + (y1 - y0) * i / nY;
        const ci = pos.length / 3;
        pos.push(0, y, (sample(P, 'bot', y) + sample(P, 'top', y)) / 2);
        for (let j = 0; j < nA; j++) {
            const a = i * nA + j, b = i * nA + (j + 1) % nA;
            if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
}

// Thin strip lying on the top of a lofted surface, centred at x = cx
function topRibbon(P, y0, y1, cx, halfW) {
    const pos = [], idx = [];
    const N = 40;
    const topAt = (y, x) => {
        // find the section angle whose x matches, near the top
        let lo = 0, hi = Math.PI / 2;
        for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (sectionPoint(P, y, m)[0] > x) lo = m; else hi = m; }
        return sectionPoint(P, y, (lo + hi) / 2)[2] + 0.004;
    };
    for (let i = 0; i <= N; i++) {
        const y = y0 + (y1 - y0) * i / N;
        pos.push(cx - halfW, y, topAt(y, Math.abs(cx - halfW)), cx + halfW, y, topAt(y, Math.abs(cx + halfW)));
    }
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
}

// Lathe around the car's lateral (X) axis from [radius, x] pairs
function lathe(points, segs) {
    const g = new THREE.LatheGeometry(points.map(([r, x]) => new THREE.Vector2(r, x)), segs);
    g.rotateZ(-Math.PI / 2);                     // lathe axis Y → X
    return g;
}

export function buildCar({ paint = '#d7141a', ghost = false } = {}) {
    const root = new THREE.Group();       // yaw + position
    const tilt = new THREE.Group();       // body roll / pitch
    root.add(tilt);

    const mats = ghost ? ghostMaterials() : solidMaterials(paint);

    // ── Body ────────────────────────────────────────────────────────────────
    // Lofted from rounded cross-sections along the car (see loft()), so the sides have
    // tumblehome, the fenders flare over the wheels and the nose and tail are rounded.
    tilt.add(new THREE.Mesh(loft(BODY, -LEN / 2, LEN / 2, 64, 28), mats.paint));
    tilt.add(new THREE.Mesh(loft(GREENHOUSE, -1.58, 0.95, 36, 24), mats.glass));
    tilt.add(new THREE.Mesh(loft(ROOF, -0.92, 0.12, 20, 24), mats.paint));
    // Twin racing stripes that follow the bonnet, roof and deck surfaces
    for (const sx of [-0.11, 0.11]) {
        tilt.add(new THREE.Mesh(topRibbon(BODY, -LEN / 2 + 0.06, -1.5, sx, 0.075), mats.stripe));
        tilt.add(new THREE.Mesh(topRibbon(BODY, 0.95, LEN / 2 - 0.05, sx, 0.075), mats.stripe));
        tilt.add(new THREE.Mesh(topRibbon(ROOF, -0.9, 0.1, sx, 0.075), mats.stripe));
    }

    // Front intake, mirrors, exhausts
    const intake = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.16), mats.carbon);
    intake.position.set(0, 2.29, 0.3);
    tilt.add(intake);
    for (const sx of [-1, 1]) {
        const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.09), mats.paint);
        mirror.position.set(sx * 0.93, 0.78, 0.98);
        tilt.add(mirror);
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.12, 12), mats.rim);
        pipe.position.set(sx * 0.32, -2.33, 0.26);
        tilt.add(pipe);
    }

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
    // Headlights sit flush in the front fenders, following the bonnet's slope
    for (const sx of [-1, 1]) {
        const y = 2.16, z = sectionPoint(BODY, y, Math.PI / 2 - 0.5)[2] - 0.03;
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.025), mats.headlight);
        head.position.set(sx * 0.6, y, z);
        head.rotation.x = -0.6;           // lie along the downward slope of the nose
        tilt.add(head);
    }
    // Full-width tail-light bar across the flat Kamm tail, plus a dark rear panel
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.03, 0.07), mats.taillight);
    tail.position.set(0, -2.345, 0.64);
    tilt.add(tail);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.02, 0.1), mats.carbon);
    panel.position.set(0, -2.335, 0.36);
    tilt.add(panel);

    // ── Wheels ──────────────────────────────────────────────────────────────
    // Tyre: lathe with rounded shoulders. Rim: dished barrel + 5 spokes, brake disc and caliper.
    const tyreGeo = lathe([
        [WHEEL_R * 0.68, -WHEEL_W / 2], [WHEEL_R * 0.9, -WHEEL_W / 2 - 0.01], [WHEEL_R - 0.03, -WHEEL_W / 2 + 0.005],
        [WHEEL_R, -WHEEL_W / 2 + 0.05], [WHEEL_R, WHEEL_W / 2 - 0.05], [WHEEL_R - 0.03, WHEEL_W / 2 - 0.005],
        [WHEEL_R * 0.9, WHEEL_W / 2 + 0.01], [WHEEL_R * 0.68, WHEEL_W / 2],
    ], 32);
    const rimGeo = lathe([
        [WHEEL_R * 0.69, -WHEEL_W / 2 + 0.01], [WHEEL_R * 0.69, WHEEL_W / 2 + 0.005], [WHEEL_R * 0.62, WHEEL_W / 2 - 0.01],
        [WHEEL_R * 0.2, WHEEL_W / 2 - 0.05], [0.0, WHEEL_W / 2 - 0.05],
    ], 24);
    const spokeGeo = new THREE.BoxGeometry(0.035, WHEEL_R * 0.62, 0.055).translate(WHEEL_W / 2 - 0.03, WHEEL_R * 0.33, 0);
    const discGeo = new THREE.CylinderGeometry(WHEEL_R * 0.55, WHEEL_R * 0.55, 0.03, 20).rotateZ(Math.PI / 2);
    const caliperGeo = new THREE.BoxGeometry(0.07, 0.1, 0.16).translate(0.02, WHEEL_R * 0.47, 0);

    const wheels = [];
    const steerPivots = [];
    for (const [ay, front] of [[AXLE_F, true], [AXLE_R, false]]) {
        for (const sx of [-1, 1]) {
            const steer = new THREE.Group();
            steer.position.set(sx * TRACK_HALF, ay, WHEEL_R);
            const spin = new THREE.Group();
            spin.add(new THREE.Mesh(tyreGeo, mats.tyre));
            spin.add(new THREE.Mesh(rimGeo, mats.rim));
            for (let k = 0; k < 5; k++) {
                const sp = new THREE.Mesh(spokeGeo, mats.rim);
                sp.rotation.x = k * Math.PI * 2 / 5;
                spin.add(sp);
            }
            spin.add(new THREE.Mesh(discGeo, mats.carbon));
            spin.scale.x = sx;                     // spokes/dish face outward on both sides
            steer.add(spin);
            const caliper = new THREE.Mesh(caliperGeo, mats.caliper);
            caliper.scale.x = sx;
            steer.add(caliper);                    // caliper doesn't spin
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
        tyre: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92, side: THREE.DoubleSide }),
        rim: new THREE.MeshStandardMaterial({ color: '#b9bec6', metalness: 0.9, roughness: 0.28, side: THREE.DoubleSide }),
        caliper: new THREE.MeshStandardMaterial({ color: '#f2c200', metalness: 0.2, roughness: 0.4 }),
        headlight: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4dc', emissiveIntensity: 1.2 }),
        taillight: new THREE.MeshStandardMaterial({ color: '#400000', emissive: '#ff1a1a', emissiveIntensity: 0.6 }),
    };
    m.all = Object.values(m).map(tag);
    return m;
}

function ghostMaterials() {
    const g = new THREE.MeshBasicMaterial({ color: '#5ee7ff', transparent: true, opacity: 0.28, depthWrite: false });
    const edge = new THREE.MeshBasicMaterial({ color: '#b8f6ff', transparent: true, opacity: 0.4, depthWrite: false });
    const m = { paint: g, stripe: edge, glass: g, carbon: g, tyre: g, rim: edge, caliper: edge, headlight: edge, taillight: edge };
    m.all = [g, edge];
    return m;
}
