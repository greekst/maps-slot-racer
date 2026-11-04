// Street furniture: street lights (with night glow and light pools on the road) and
// mast-arm traffic signals at the real signal locations. All instanced: a handful of
// draw calls for ~1–2k objects.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { spec } from './roads.js';
import { hash01 } from './data.js';

const LIGHT_SPACING = 32;     // m between lights along one side
const LIGHT_HEIGHT = 8.2;
const ARM = 1.9;

const zUp = g => g.rotateX(Math.PI / 2);

function streetLightGeometry() {
    const pole = zUp(new THREE.CylinderGeometry(0.07, 0.12, LIGHT_HEIGHT, 8)).translate(0, 0, LIGHT_HEIGHT / 2);
    const base = zUp(new THREE.CylinderGeometry(0.2, 0.22, 0.5, 8)).translate(0, 0, 0.25);
    const arm = new THREE.BoxGeometry(ARM, 0.07, 0.07).translate(ARM / 2, 0, LIGHT_HEIGHT - 0.1);
    const housing = new THREE.BoxGeometry(0.7, 0.28, 0.14).translate(ARM + 0.2, 0, LIGHT_HEIGHT - 0.16);
    return mergeGeometries([pole, base, arm, housing]);
}

function signalPoleGeometry(armLen) {
    const pole = zUp(new THREE.CylinderGeometry(0.14, 0.2, 6.8, 10)).translate(0, 0, 3.4);
    const arm = new THREE.BoxGeometry(armLen, 0.12, 0.12).translate(armLen / 2, 0, 6.4);
    return mergeGeometries([pole, arm]);
}

// Soft radial sprite texture for glows and pools
function radialTexture(stops) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [t, col] of stops) grd.addColorStop(t, col);
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// Camera-facing quads (billboards). Our view matrix has no rotation (Mapbox's matrix
// carries it), so the camera's right/up vectors come in as uniforms.
function billboardMaterial(map, color) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        uniforms: { map: { value: map }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 0, 1) }, uOpacity: { value: 1 }, uColor: { value: new THREE.Color(color) } },
        vertexShader: `
            uniform vec3 uRight, uUp; varying vec2 vUv;
            void main() {
                vUv = uv;
                vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                float s = length(instanceMatrix[0].xyz);
                vec3 p = c.xyz + (uRight * position.x + uUp * position.y) * s;
                gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
            }`,
        fragmentShader: `
            uniform sampler2D map; uniform float uOpacity; uniform vec3 uColor; varying vec2 vUv;
            void main() { vec4 t = texture2D(map, vUv); gl_FragColor = vec4(uColor * t.rgb * t.a * uOpacity, 1.0); }`,
    });
}

function nearestRoad(roads, x, y, maxD) {
    let best = null, bd = maxD;
    for (const o of roads) {
        const c = o.r.coords;
        for (let i = 0; i < c.length - 1; i++) {
            const ax = c[i][0], ay = c[i][1], bx = c[i + 1][0], by = c[i + 1][1];
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
            const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
            if (d < bd) { bd = d; best = { o, dir: Math.atan2(dx, dy), d }; }
        }
    }
    return best;
}

export function buildFurniture(city, { dist, nearJunction = () => false, maxDist = 380 }) {
    const group = new THREE.Group();
    group.name = 'furniture';
    const roads = city.roads.map(r => ({ r, s: spec(r) }))
        .filter(o => o.s && !o.s.noMarks && o.r.structure !== 'tunnel' && o.r.coords.length > 1);

    // ── Street lights: walk each road, alternate sides, dedupe on a 10 m grid ──
    const taken = new Set();
    const lights = [];
    for (const { r, s } of roads) {
        const c = r.coords;
        let along = hash01(Math.round(c[0][0] * 7 + c[0][1] * 13)) * LIGHT_SPACING;
        let side = 1;
        for (let i = 0; i < c.length - 1; i++) {
            const ax = c[i][0], ay = c[i][1], dx = c[i + 1][0] - ax, dy = c[i + 1][1] - ay;
            const L = Math.hypot(dx, dy);
            if (L < 0.01) continue;
            const tx = dx / L, ty = dy / L;
            while (along < L) {
                const px = ax + tx * along, py = ay + ty * along;
                along += LIGHT_SPACING / 2;            // one side every 16 m, so each side every 32 m
                side = -side;
                if (dist(px, py) > maxDist || nearJunction(px, py)) continue;
                const off = s.w / 2 + 0.9;
                // right normal (ty, -tx)
                const lx = px + ty * off * side, ly = py - tx * off * side;
                const key = `${Math.round(lx / 10)},${Math.round(ly / 10)}`;
                if (taken.has(key)) continue;
                taken.add(key);
                // arm points back toward the road: yaw such that local +X → (-ty·side, tx·side)
                const yaw = Math.atan2(tx * side, -ty * side);
                lights.push({ x: lx, y: ly, yaw });
            }
            along -= L;
        }
    }

    const metal = new THREE.MeshStandardMaterial({ color: '#3c3f44', roughness: 0.45, metalness: 0.7 });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1), one = new THREE.Vector3(1, 1, 1);
    const place = (x, y, z, yaw, scale = one) => m4.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(Z, yaw), scale);

    const poleMesh = new THREE.InstancedMesh(streetLightGeometry(), metal, lights.length);
    const lampMat = new THREE.MeshStandardMaterial({ color: '#202020', emissive: '#ffd9a0', emissiveIntensity: 0, roughness: 0.3 });
    const lampMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.2, 0.03).translate(ARM + 0.2, 0, LIGHT_HEIGHT - 0.245), lampMat, lights.length);
    const glowTex = radialTexture([[0, 'rgba(255,236,200,1)'], [0.15, 'rgba(255,214,150,0.7)'], [0.5, 'rgba(255,190,120,0.12)'], [1, 'rgba(255,180,110,0)']]);
    const poolTex = radialTexture([[0, 'rgba(255,214,160,0.9)'], [0.45, 'rgba(255,200,140,0.35)'], [1, 'rgba(255,190,130,0)']]);
    const glowMat = billboardMaterial(glowTex, '#ffe2b8');
    const glowMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, lights.length);
    const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, color: '#ffcf9a', polygonOffset: true, polygonOffsetFactor: -2 });
    const poolMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), poolMat, lights.length);
    lights.forEach((l, i) => {
        poleMesh.setMatrixAt(i, place(l.x, l.y, 0, l.yaw));
        lampMesh.setMatrixAt(i, place(l.x, l.y, 0, l.yaw));
        const hx = l.x + Math.cos(l.yaw) * (ARM + 0.2), hy = l.y + Math.sin(l.yaw) * (ARM + 0.2);
        glowMesh.setMatrixAt(i, place(hx, hy, LIGHT_HEIGHT - 0.3, 0, new THREE.Vector3(3.2, 3.2, 3.2)));
        poolMesh.setMatrixAt(i, place(hx + Math.cos(l.yaw) * 1.2, hy + Math.sin(l.yaw) * 1.2, 0.04, 0, new THREE.Vector3(15, 15, 1)));
    });
    for (const m of [poleMesh, lampMesh, glowMesh, poolMesh]) { m.frustumCulled = false; m.instanceMatrix.needsUpdate = true; }
    glowMesh.renderOrder = 3; poolMesh.renderOrder = 2;
    poleMesh.castShadow = true;
    group.add(poleMesh, lampMesh, poolMesh, glowMesh);

    // ── Traffic signals: two mast arms per signalised junction, over the main road ──
    // OSM maps one signal node per approach; cluster nodes within 40 m into one junction
    const clusters = [];
    for (const [x, y] of city.signals) {
        if (dist(x, y) > maxDist + 100) continue;
        const c = clusters.find(c => Math.hypot(c.x / c.n - x, c.y / c.n - y) < 40);
        if (c) { c.x += x; c.y += y; c.n++; } else clusters.push({ x, y, n: 1 });
    }
    const signals = [];
    for (const c of clusters) {
        const x = c.x / c.n, y = c.y / c.n;
        const n = nearestRoad(roads, x, y, 18);
        if (!n) continue;
        const w = n.o.s.w;
        // the cross street sets how far past the junction centre the pole stands
        const cross = nearestRoad(roads.filter(o => o !== n.o && Math.abs(Math.sin(nearestRoad([o], x, y, 25)?.dir - n.dir || 0)) > 0.7), x, y, 25);
        const along = (cross ? cross.o.s.w / 2 : 5) + 2.2;
        for (const side of [1, -1]) {
            // pole on the far-right corner for traffic approaching in direction `dir·side`
            const h = n.dir + (side < 0 ? Math.PI : 0);
            const fx = Math.sin(h), fy = Math.cos(h);
            const px = x + fx * along + fy * (w / 2 + 1.4), py = y + fy * along - fx * (w / 2 + 1.4);
            signals.push({ x: px, y: py, armLen: w / 2 + 1.2, phase: side > 0 ? 0 : 0.5, fx, fy });
        }
    }
    const sigMetal = new THREE.MeshStandardMaterial({ color: '#5b5e5a', roughness: 0.5, metalness: 0.6 });
    const sigPole = new THREE.InstancedMesh(signalPoleGeometry(7.5), sigMetal, signals.length);
    const headGeo = new THREE.BoxGeometry(0.36, 0.3, 1.05);
    const headMat = new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.6 });
    const HEADS = 2;
    const sigHead = new THREE.InstancedMesh(headGeo, headMat, signals.length * HEADS);
    const lampGeo = new THREE.CircleGeometry(0.12, 12).rotateX(Math.PI / 2);   // facing -Y (local)
    const sigLamp = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), signals.length * HEADS * 3);
    const lampInfo = [];
    signals.forEach((sg, i) => {
        // arm points over the road (to the left of the pole for traffic heading `fx,fy`)
        const ax = -sg.fy, ay = sg.fx;                 // left normal
        const yaw = Math.atan2(ay, ax);
        // geometry arm is along local +X; rotate so it points along (ax, ay)
        sigPole.setMatrixAt(i, place(sg.x, sg.y, 0, yaw));
        for (let k = 0; k < HEADS; k++) {
            const d = sg.armLen * (0.45 + 0.45 * k);
            const hx = sg.x + ax * d, hy = sg.y + ay * d;
            // heads face oncoming traffic: local -Y → (-fx, -fy)
            const faceYaw = Math.atan2(-sg.fx, sg.fy);
            sigHead.setMatrixAt(i * HEADS + k, place(hx, hy, 5.75, faceYaw));
            for (let L = 0; L < 3; L++) {
                const z = 6.1 - L * 0.33;
                const j = (i * HEADS + k) * 3 + L;
                sigLamp.setMatrixAt(j, place(hx - sg.fx * 0.16, hy - sg.fy * 0.16, z, faceYaw));
                lampInfo.push({ j, L, phase: sg.phase });
            }
        }
    });
    for (const m of [sigPole, sigHead, sigLamp]) { m.frustumCulled = false; m.instanceMatrix.needsUpdate = true; }
    sigPole.castShadow = sigHead.castShadow = true;
    group.add(sigPole, sigHead, sigLamp);

    // Signal cycle: 0–0.42 green, 0.42–0.5 amber, 0.5–1 red (cross street offset by half)
    const ON = [new THREE.Color('#ff2a1a'), new THREE.Color('#ffb000'), new THREE.Color('#22ff7a')];
    const OFF = [new THREE.Color('#2a0a08'), new THREE.Color('#2a1d05'), new THREE.Color('#06240f')];
    const CYCLE = 40;
    let lastState = -1, night = 0;
    const tmpC = new THREE.Color();
    function updateSignals(t) {
        const phaseNow = (t / CYCLE) % 1;
        const state = Math.floor(phaseNow * 80);
        if (state === lastState) return;
        lastState = state;
        for (const { j, L, phase } of lampInfo) {
            const p = (phaseNow + phase) % 1;
            const active = p < 0.42 ? 2 : p < 0.5 ? 1 : 0;
            const c = L === active ? tmpC.copy(ON[L]).multiplyScalar(1.2 + 1.8 * night) : OFF[L];
            sigLamp.setColorAt(j, c);
        }
        sigLamp.instanceColor.needsUpdate = true;
    }

    return {
        group,
        counts: { lights: lights.length, signals: signals.length },
        onLight(env) {
            night = env.lights;
            lampMat.emissiveIntensity = 0.3 + 5 * env.lights;
            glowMat.uniforms.uOpacity.value = env.lights * 1.1;
            poolMat.opacity = env.lights * 0.55;
            glowMesh.visible = poolMesh.visible = env.lights > 0.02;
            lastState = -1;
        },
        onFrame({ right, up, t }) {
            glowMat.uniforms.uRight.value.copy(right);
            glowMat.uniforms.uUp.value.copy(up);
            updateSignals(t);
        },
    };
}
