// Palms on the sidewalks and parked cars at the kerbs: instanced, a few draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loft } from '../car-model.js';
import { spec } from './roads.js';
import { hash01 } from './data.js';

// Small seeded RNG so placement is the same every run
function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

// Point grid for "is anything within r of (x, y)" tests
function pointGrid(points, cell = 8) {
    const g = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    for (const [x, y] of points) { const k = key(x, y); if (!g.has(k)) g.set(k, []); g.get(k).push([x, y]); }
    return {
        near(x, y, r) {
            const gx = Math.floor(x / cell), gy = Math.floor(y / cell), n = Math.ceil(r / cell);
            for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) {
                for (const p of g.get(`${gx + dx},${gy + dy}`) || []) if ((p[0] - x) ** 2 + (p[1] - y) ** 2 < r * r) return true;
            }
            return false;
        },
        add(x, y) { const k = key(x, y); if (!g.has(k)) g.set(k, []); g.get(k).push([x, y]); },
    };
}

// Instanced meshes split into spatial chunks so the frustum culls what's off-screen
// (one InstancedMesh's bounds would span the whole city).
function chunked(group, geo, mat, items, matrixOf, { cell = 150, colorOf, shadow = true } = {}) {
    const cells = new Map();
    for (const it of items) {
        const k = `${Math.floor(it.x / cell)},${Math.floor(it.y / cell)}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(it);
    }
    for (const list of cells.values()) {
        const mesh = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((it, i) => {
            mesh.setMatrixAt(i, matrixOf(it));
            if (colorOf) mesh.setColorAt(i, colorOf(it));
        });
        mesh.computeBoundingSphere();
        mesh.castShadow = shadow;
        group.add(mesh);
    }
}

// Walk a polyline, calling fn(x, y, tx, ty) every `step()` metres
function walk(coords, first, step, fn) {
    let along = first;
    for (let i = 0; i < coords.length - 1; i++) {
        const ax = coords[i][0], ay = coords[i][1];
        const dx = coords[i + 1][0] - ax, dy = coords[i + 1][1] - ay;
        const L = Math.hypot(dx, dy);
        if (L < 0.01) continue;
        const tx = dx / L, ty = dy / L;
        while (along < L) { fn(ax + tx * along, ay + ty * along, tx, ty); along += step(); }
        along -= L;
    }
}

// ── Palm ─────────────────────────────────────────────────────────────────────
function palmGeometry(height, lean, seed) {
    const r = rng(seed);
    // Trunk: tapered cylinder bent along a gentle curve, with darker growth rings (vertex colours)
    const trunk = new THREE.CylinderGeometry(0.13, 0.2, height, 8, 14, true).rotateX(Math.PI / 2).translate(0, 0, height / 2);
    const p = trunk.attributes.position, cols = [];
    for (let i = 0; i < p.count; i++) {
        const z = p.getZ(i), t = z / height;
        p.setX(i, p.getX(i) + lean * t * t * height * 0.18);
        const ring = 0.86 + 0.14 * Math.abs(Math.sin(z * 7.5));
        cols.push(0.55 * ring, 0.48 * ring, 0.38 * ring);
    }
    trunk.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    trunk.computeVertexNormals();
    const top = new THREE.Vector3(lean * height * 0.18, 0, height);

    // Fronds: drooping arcs, each a folded strip (centre rib raised) tapering to a point
    const fronds = [];
    const N = 11;
    for (let k = 0; k < N; k++) {
        const yaw = (k / N) * Math.PI * 2 + r() * 0.4;
        const len = 2.6 + r() * 0.9, rise = 0.5 + r() * 0.5, droop = 1.6 + r() * 1.0;
        const pos = [], idx = [];
        const S = 9;
        for (let i = 0; i <= S; i++) {
            const t = i / S;
            const along = t * len;
            const z = rise * Math.sin(t * Math.PI * 0.6) - droop * t * t;
            const w = 0.42 * Math.sin(Math.min(1, t * 1.15) * Math.PI) * (1 - 0.3 * t) + 0.02;
            const c = Math.cos(yaw), s = Math.sin(yaw);
            const cx = top.x + c * along, cy = top.y + s * along, cz = top.z + z;
            // left edge, rib (raised), right edge; leaflets hang a bit below the rib
            pos.push(cx - s * w, cy + c * w, cz - w * 0.35, cx, cy, cz + 0.04, cx + s * w, cy - c * w, cz - w * 0.35);
        }
        for (let i = 0; i < S; i++) {
            const a = i * 3;
            idx.push(a, a + 1, a + 4, a, a + 4, a + 3, a + 1, a + 2, a + 5, a + 1, a + 5, a + 4);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        const fc = [];
        const shade = 0.75 + r() * 0.35;
        for (let i = 0; i < pos.length / 3; i++) fc.push(0.22 * shade, 0.42 * shade, 0.16 * shade);
        g.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
        g.computeVertexNormals();
        fronds.push(g);
    }
    // a few coconuts / dead-frond skirt at the crown
    const skirt = new THREE.ConeGeometry(0.32, 0.7, 8, 1, true).rotateX(-Math.PI / 2).translate(top.x, 0, height - 0.15);
    const sc = []; for (let i = 0; i < skirt.attributes.position.count; i++) sc.push(0.42, 0.33, 0.2);
    skirt.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    for (const g of [trunk, skirt, ...fronds]) { g.deleteAttribute('uv'); }
    return mergeGeometries([trunk, skirt, ...fronds]);
}

function swayMaterial(uniforms) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    m.onBeforeCompile = sh => {
        sh.uniforms.uTime = uniforms.uTime;
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
float seed = instanceMatrix[3].x * 0.37 + instanceMatrix[3].y * 0.11;
#else
float seed = 0.0;
#endif
float sway = smoothstep(4.0, 9.0, transformed.z);
transformed.x += sway * (sin(uTime * 1.1 + seed) * 0.12 + sin(uTime * 2.7 + seed * 1.7) * 0.04);
transformed.y += sway * sin(uTime * 0.9 + seed * 0.6) * 0.08;`);
    };
    return m;
}

// ── Parked car ───────────────────────────────────────────────────────────────
const CARS = [
    // sedan
    { len: 4.7, body: { y: [-2.35, -2.2, -1.2, 0.0, 1.2, 2.1, 2.35], hw: [0.82, 0.88, 0.9, 0.9, 0.9, 0.86, 0.78], bot: [0.3, 0.22, 0.2, 0.2, 0.2, 0.24, 0.32], top: [0.82, 0.92, 0.95, 0.95, 0.92, 0.8, 0.66], n: [6, 6.5, 7, 7, 7, 6, 5], tuck: [0.06, 0.06, 0.07, 0.07, 0.07, 0.06, 0.05] },
      cabin: { y: [-1.55, -1.1, 0.4, 0.95], hw: [0.66, 0.72, 0.74, 0.7], bot: [0.9, 0.9, 0.9, 0.9], top: [0.95, 1.38, 1.4, 0.95], n: [5, 5, 5, 5], tuck: [0.36, 0.36, 0.36, 0.36] }, cab: [-1.55, 0.95] },
    // hatchback
    { len: 4.1, body: { y: [-2.05, -1.95, -1.0, 0.0, 1.0, 1.8, 2.05], hw: [0.8, 0.86, 0.87, 0.87, 0.87, 0.84, 0.76], bot: [0.3, 0.22, 0.2, 0.2, 0.2, 0.24, 0.32], top: [0.95, 0.98, 0.98, 0.97, 0.94, 0.82, 0.66], n: [7, 6.5, 7, 7, 7, 6, 5], tuck: [0.06, 0.06, 0.07, 0.07, 0.07, 0.06, 0.05] },
      cabin: { y: [-1.98, -1.7, 0.3, 0.9], hw: [0.68, 0.72, 0.74, 0.7], bot: [0.94, 0.94, 0.94, 0.94], top: [1.3, 1.42, 1.44, 0.97], n: [5, 5, 5, 5], tuck: [0.34, 0.34, 0.34, 0.34] }, cab: [-1.98, 0.9] },
    // SUV
    { len: 4.9, body: { y: [-2.45, -2.35, -1.2, 0.0, 1.2, 2.2, 2.45], hw: [0.9, 0.95, 0.96, 0.96, 0.96, 0.93, 0.86], bot: [0.42, 0.32, 0.3, 0.3, 0.3, 0.34, 0.44], top: [1.05, 1.1, 1.12, 1.12, 1.1, 1.0, 0.86], n: [8, 8, 8, 8, 8, 7, 6], tuck: [0.05, 0.05, 0.06, 0.06, 0.06, 0.05, 0.05] },
      cabin: { y: [-2.38, -2.1, 0.6, 1.25], hw: [0.8, 0.84, 0.86, 0.82], bot: [1.08, 1.08, 1.08, 1.08], top: [1.62, 1.72, 1.74, 1.12], n: [6, 6, 6, 6], tuck: [0.22, 0.22, 0.22, 0.22] }, cab: [-2.38, 1.25] },
];
const PAINTS = ['#f2f2f0', '#f2f2f0', '#1b1c1f', '#1b1c1f', '#9aa0a6', '#9aa0a6', '#5d6166', '#24426b', '#8e1b1b', '#c9b18f', '#3d5c47', '#d9d4c7'];

function parkedCarGeometries(v) {
    const body = loft(v.body, -v.len / 2, v.len / 2, 14, 16);
    const glass = loft(v.cabin, v.cab[0], v.cab[1], 6, 16);
    const wheels = [];
    const wy = v.len / 2 - 0.85;
    for (const y of [wy, -wy]) for (const sx of [-1, 1]) {
        wheels.push(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 10).rotateZ(Math.PI / 2).translate(sx * (v.body.hw[3] - 0.1), y, 0.33));
    }
    const dark = mergeGeometries([glass, ...wheels.map(w => { w.deleteAttribute('uv'); return w; })]);
    return { body, dark };
}

export function buildProps(city, { dist, nearJunction = () => false, lights = [], maxDist = 300 }) {
    const group = new THREE.Group();
    group.name = 'props';
    const roads = city.roads.map(r => ({ r, s: spec(r) }))
        .filter(o => o.s && !o.s.noMarks && o.r.structure !== 'tunnel' && o.r.coords.length > 1);
    const lightGrid = pointGrid(lights);
    const crossPts = [];
    for (const r of city.roads) if (r.class === 'path' && r.type === 'crossing') for (const p of r.coords) crossPts.push(p);
    const crossGrid = pointGrid(crossPts);
    const uniforms = { uTime: { value: 0 } };

    // ── Palms: on most streets near the circuit, both sidewalks, ~13 m apart ──
    const palms = [];
    const palmGrid = pointGrid([]);
    for (const { r, s } of roads) {
        const seed = Math.round(r.coords[0][0] * 31 + r.coords[0][1] * 17);
        if (hash01(seed) < 0.3) continue;                 // some streets have no palms
        const R = rng(seed);
        for (const side of [-1, 1]) {
            walk(r.coords, R() * 10, () => 11 + R() * 5, (x, y, tx, ty) => {
                if (dist(x, y) > maxDist || nearJunction(x, y)) return;
                const off = s.w / 2 + 1.5 + R() * 0.4;
                const px = x + ty * off * side, py = y - tx * off * side;
                if (lightGrid.near(px, py, 4) || palmGrid.near(px, py, 6) || crossGrid.near(px, py, 4)) return;
                palmGrid.add(px, py);
                palms.push({ x: px, y: py, yaw: R() * Math.PI * 2, scale: 0.85 + R() * 0.35, v: Math.floor(R() * 3) });
            });
        }
    }
    const palmMat = swayMaterial(uniforms);
    const variants = [palmGeometry(8.5, 0.6, 7), palmGeometry(10.5, -0.4, 19), palmGeometry(7.2, 0.9, 41)];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
    variants.forEach((geo, vi) => {
        chunked(group, geo, palmMat, palms.filter(p => p.v === vi),
            p => m4.compose(new THREE.Vector3(p.x, p.y, 0), q.setFromAxisAngle(Z, p.yaw), new THREE.Vector3(p.scale, p.scale, p.scale)));
    });

    // ── Parked cars: kerb lane of streets, gaps for junctions, crossings and driveways ──
    const cars = [];
    for (const { r, s } of roads) {
        if (s.w < 9 || r.class === 'trunk' || r.class === 'motorway') continue;
        const seed = Math.round(r.coords[0][0] * 13 + r.coords[0][1] * 7) + 99;
        const R = rng(seed);
        const sides = r.oneway ? [1, -1] : [1, -1];
        for (const side of sides) {
            const occupancy = 0.45 + R() * 0.35;
            walk(r.coords, R() * 6, () => 6.2 + R() * 1.6, (x, y, tx, ty) => {
                if (R() > occupancy || dist(x, y) > maxDist) return;
                const off = s.w / 2 - 1.15;
                const px = x + ty * off * side, py = y - tx * off * side;
                // keep clear of junctions (with margin), crossings, and the slot itself
                for (const d of [-6, 0, 6]) if (nearJunction(px + tx * d, py + ty * d)) return;
                if (crossGrid.near(px, py, 7) || dist(px, py) < 2.6) return;
                const v = Math.floor(R() * 10) < 5 ? 0 : R() < 0.5 ? 1 : 2;
                // parked with the flow of traffic on that side
                const fwd = r.oneway || side > 0 ? 1 : -1;
                cars.push({ x: px, y: py, h: Math.atan2(tx * fwd, ty * fwd) + (R() - 0.5) * 0.04, v, paint: PAINTS[Math.floor(R() * PAINTS.length)] });
            });
        }
    }
    const bodyMat = new THREE.MeshPhysicalMaterial({ roughness: 0.35, metalness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.15 });
    const darkMat = new THREE.MeshStandardMaterial({ color: '#0d1116', roughness: 0.15, metalness: 0.5 });
    const col = new THREE.Color();
    CARS.forEach((v, vi) => {
        const list = cars.filter(c => c.v === vi);
        const { body, dark } = parkedCarGeometries(v);
        const mat = c => m4.compose(new THREE.Vector3(c.x, c.y, 0), q.setFromAxisAngle(Z, -c.h), new THREE.Vector3(1, 1, 1));
        chunked(group, body, bodyMat, list, mat, { colorOf: c => col.set(c.paint) });
        chunked(group, dark, darkMat, list, mat);
    });

    return {
        group,
        counts: { palms: palms.length, parked: cars.length },
        onFrame({ t }) { uniforms.uTime.value = t; },
    };
}
