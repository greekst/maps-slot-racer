// Buildings with procedural facades, built from Mapbox Streets footprints.
//
// One merged mesh, one draw call. Each wall quad carries its own (u, wallLength) so
// the shader fits a whole number of window bays to every wall, and a per-building
// seed/style so the shader can pick palette, floor height, bay width and night lights.
// Lighting, reflections and tone mapping come from MeshStandardMaterial; the facade
// is injected with onBeforeCompile.

import * as THREE from 'three';
import { hash01, ringArea } from './data.js';

// Styles (shader switch): 0 low-rise Art Deco/residential, 1 glass tower,
// 2 parking deck, 3 canopy/shed (plain), 4 house
const STYLE = { lowrise: 0, tower: 1, parking: 2, plain: 3, house: 4 };

function styleOf(b) {
    const t = b.type;
    if (t === 'parking' || t === 'garage' || t === 'garages' || t === 'carport') return STYLE.parking;
    if (t === 'roof' || t === 'shelter' || t === 'shed' || t === 'service' || t === 'construction' || b.mh > 0 && b.h - b.mh < 2.5) return STYLE.plain;
    if (b.h >= 32) return STYLE.tower;
    if (t === 'house' || t === 'detached' || t === 'cabin' || b.h < 4.5) return STYLE.house;
    return STYLE.lowrise;
}

// Ground floor gets storefronts for these types (or any low-rise on a busy street)
const COMMERCIAL = new Set(['commercial', 'retail', 'hotel', 'office', 'public']);

function signedArea(r) {
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
    return s / 2;   // >0 = counter-clockwise (x East, y North)
}

export function buildBuildings(buildings, { busy = () => false } = {}) {
    const pos = [], nrm = [], wall = [], info = [], idx = [];
    let vi = 0;

    for (const b of buildings) {
        const style = styleOf(b);
        const seed = Math.floor(hash01(b.id) * 65536);   // integer: exact through interpolation
        let h = b.h, mh = b.mh;
        if (h - mh < 0.5) continue;
        const cx = b.rings[0][0][0], cy = b.rings[0][0][1];
        const shop = style === STYLE.lowrise && (COMMERCIAL.has(b.type) || busy(cx, cy)) ? 1 : 0;
        // info: seed, style, height, flags (bit0 = storefront ground floor)
        const inf = [seed, style, h, shop];

        // Walls
        b.rings.forEach((ring, k) => {
            const ccw = signedArea(ring) > 0;
            // outer ring CCW, holes CW → (dy, -dx) is always the outward normal
            const r = (k === 0) === ccw ? ring : [...ring].reverse();
            for (let i = 0; i < r.length; i++) {
                const a = r[i], c = r[(i + 1) % r.length];
                const dx = c[0] - a[0], dy = c[1] - a[1];
                const len = Math.hypot(dx, dy);
                if (len < 0.05) continue;
                const nx = dy / len, ny = -dx / len;
                pos.push(a[0], a[1], mh, c[0], c[1], mh, c[0], c[1], h, a[0], a[1], h);
                for (let q = 0; q < 4; q++) nrm.push(nx, ny, 0);
                wall.push(0, len, len, len, len, len, 0, len);
                for (let q = 0; q < 4; q++) info.push(...inf);
                idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
                vi += 4;
            }
        });

        // Roof (earcut via ShapeUtils). wall.y = -1 flags roof fragments.
        const contour = b.rings[0].map(p => new THREE.Vector2(p[0], p[1]));
        const holes = b.rings.slice(1).map(r => r.map(p => new THREE.Vector2(p[0], p[1])));
        let tris;
        try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { tris = []; }
        const all = [contour, ...holes].flat();
        const base = vi;
        for (const p of all) {
            pos.push(p.x, p.y, h);
            nrm.push(0, 0, 1);
            wall.push(p.x, -1);
            info.push(...inf);
            vi++;
        }
        for (const t of tris) {
            // ShapeUtils returns CW triangles for CCW input in some cases; force +Z facing
            const A = all[t[0]], B = all[t[1]], C = all[t[2]];
            const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
            if (cross >= 0) idx.push(base + t[0], base + t[1], base + t[2]);
            else idx.push(base + t[0], base + t[2], base + t[1]);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 2));
    geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const material = makeFacadeMaterial();
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;      // the scene is re-anchored each frame; bounds are huge anyway
    mesh.name = 'buildings';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

export function makeFacadeMaterial() {
    const uniforms = {
        uNight: { value: 0 },       // 0 day … 1 night: window lights
        uWallTint: { value: new THREE.Color(1, 1, 1) },
    };
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
    m.userData.uniforms = uniforms;
    m.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
attribute vec2 aWall;
attribute vec4 aInfo;
varying vec2 vWall;
varying vec4 vInfo;
varying float vZ;
varying vec2 vXY;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
vWall = aWall; vInfo = aInfo; vZ = position.z; vXY = position.xy;`);

        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
uniform float uNight;
uniform vec3 uWallTint;
varying vec2 vWall;
varying vec4 vInfo;
varying float vZ;
varying vec2 vXY;
// Sin-free hashes (Dave Hoskins): stable for exact integer inputs on every GPU
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// Box mask with screen-space antialiasing: 1 inside [lo,hi] on both axes
float boxAA(vec2 p, vec2 lo, vec2 hi, vec2 fw) {
    vec2 a = smoothstep(lo - fw, lo + fw, p) * (1.0 - smoothstep(hi - fw, hi + fw, p));
    return a.x * a.y;
}
vec3 pastel(float s) {
    // South Beach palette, weighted toward white/cream
    float i = floor(s * 12.0);
    if (i < 3.0) return vec3(0.93, 0.92, 0.89);      // white
    if (i < 5.0) return vec3(0.95, 0.89, 0.77);      // cream
    if (i < 6.0) return vec3(0.95, 0.77, 0.79);      // flamingo pink
    if (i < 7.0) return vec3(0.73, 0.89, 0.81);      // mint
    if (i < 8.0) return vec3(0.66, 0.86, 0.88);      // aqua
    if (i < 9.0) return vec3(0.97, 0.81, 0.68);      // peach
    if (i < 10.0) return vec3(0.84, 0.79, 0.92);     // lavender
    if (i < 11.0) return vec3(0.95, 0.91, 0.65);     // lemon
    return vec3(0.82, 0.82, 0.80);                   // concrete
}
vec3 accentOf(float s) {
    float i = floor(s * 6.0);
    if (i < 1.0) return vec3(0.15, 0.55, 0.60);
    if (i < 2.0) return vec3(0.85, 0.40, 0.45);
    if (i < 3.0) return vec3(0.95, 0.65, 0.30);
    if (i < 4.0) return vec3(0.35, 0.65, 0.45);
    if (i < 5.0) return vec3(0.50, 0.45, 0.75);
    return vec3(0.98, 0.98, 0.98);
}`)
            .replace('#include <color_fragment>', `#include <color_fragment>
float fSeed = floor(vInfo.x + 0.5), fStyle = vInfo.y, fH = vInfo.z, fShop = vInfo.w;
bool isRoof = vWall.y < 0.0;
vec3 wallCol = pastel(h11(fSeed)) * uWallTint;
vec3 accent = accentOf(h11(fSeed + 7.0));
vec3 glass = vec3(0.06, 0.08, 0.10);
float glassMask = 0.0;       // 1 = glass pane
float lit = 0.0;             // emissive window light 0..1
vec3 litCol = vec3(1.0, 0.78, 0.5);
vec3 col = wallCol;
float rough = 0.85;
if (isRoof) {
    col = mix(vec3(0.62, 0.62, 0.60), vec3(0.80, 0.79, 0.76), h11(fSeed * 91.0));
    if (fStyle > 2.5 && fStyle < 3.5) col = wallCol * 0.85;
    // roof clutter: faint grid of AC units / membrane seams
    vec2 g = fract(vXY / 3.7);
    col *= 0.93 + 0.07 * step(0.12, min(g.x, g.y));
    rough = 0.95;
} else if (fStyle > 2.5 && fStyle < 3.5) {
    // plain canopy / shed
    col = wallCol * 0.9;
} else {
    float len = vWall.y;
    float u = vWall.x;
    float z = vZ;
    bool tower = fStyle > 0.5 && fStyle < 1.5;
    bool parking = fStyle > 1.5 && fStyle < 2.5;
    bool house = fStyle > 3.5;
    float floorH = tower ? 3.3 : parking ? 3.0 : 3.0 + 0.5 * h11(fSeed * 13.0);
    float groundH = (fShop > 0.5) ? 4.4 : floorH + 0.3;
    float bayW = tower ? 1.6 : parking ? 6.0 : 2.6 + 1.4 * h11(fSeed * 29.0);
    float bays = max(1.0, floor(len / bayW + 0.5));
    float cellW = len / bays;
    float bx = u / cellW;
    float bay = floor(bx);
    float fx = fract(bx);
    float zf = z - groundH;
    float flo = floor(zf / floorH);
    float fz = fract(zf / floorH);
    vec2 fw = vec2(fwidth(bx), fwidth(zf / floorH)) * 1.2;
    float parapet = tower ? 0.6 : 1.1;
    bool body = z > groundH && z < fH - parapet && len > 1.6;
    // fade the window pattern out where a pixel spans most of a bay (distance aliasing)
    float detail = 1.0 - smoothstep(0.35, 0.9, max(fw.x, fw.y));

    if (body) {
        if (tower) {
            // curtain wall: white balcony/slab bands, glass between, thin mullions
            float slab = 1.0 - smoothstep(0.24 - fw.y, 0.24 + fw.y, fz);
            float mull = 1.0 - smoothstep(0.04 - fw.x, 0.04 + fw.x, min(fx, 1.0 - fx));
            glassMask = (1.0 - slab) * (1.0 - mull * 0.7);
            col = mix(vec3(0.92, 0.93, 0.93), wallCol, 0.25);
            glass = mix(vec3(0.10, 0.20, 0.24), vec3(0.05, 0.09, 0.12), h11(fSeed * 3.0));
        } else if (parking) {
            float open = boxAA(vec2(fx, fz), vec2(0.04, 0.32), vec2(0.96, 0.92), fw);
            col = vec3(0.80, 0.80, 0.78);
            glassMask = open; glass = vec3(0.03, 0.03, 0.035);
        } else {
            // punched windows with a shadowed "eyebrow" ledge above (Art Deco)
            float ww = house ? 0.5 : 0.56 + 0.12 * h11(fSeed * 7.0);
            float wl = 0.5 - ww * 0.5;
            float win = boxAA(vec2(fx, fz), vec2(wl, 0.22), vec2(1.0 - wl, 0.80), fw);
            float brow = boxAA(vec2(fx, fz), vec2(wl - 0.06, 0.84), vec2(1.06 - wl, 0.90), fw);
            glassMask = win;
            col *= 1.0 - 0.35 * brow;
        }
        float wid = h21(vec2(bay + 0.5, flo + 0.5) + fSeed * 0.37);
        float litP = (tower ? 0.45 : 0.38) * uNight;
        lit = step(1.0 - litP, wid) * glassMask;
        litCol = mix(vec3(1.0, 0.74, 0.45), vec3(0.85, 0.92, 1.0), step(0.75, h11(wid * 97.0)));
        lit *= 0.45 + 0.55 * h11(wid * 53.0);
        // interior read: brighter toward the ceiling, some windows half-curtained
        lit *= 0.55 + 0.45 * smoothstep(0.25, 0.8, fz);
        float curtain = step(0.55, h11(wid * 31.0)) * step(fx, 0.5 + 0.3 * (h11(wid * 7.0) - 0.5));
        lit *= 1.0 - 0.6 * curtain;
    } else if (z <= groundH && len > 1.6) {
        if (fShop > 0.5) {
            // storefront: big glass between 0.35 m and 3.1 m, mullions every bay/2, accent awning band
            float sx = fract(u / (cellW * 0.5));
            float sfw = fwidth(u / (cellW * 0.5)) * 1.2;
            float g = boxAA(vec2(sx, z), vec2(0.05, 0.35), vec2(0.95, 3.1), vec2(sfw, fwidth(z) * 1.2));
            glassMask = g;
            glass = vec3(0.07, 0.07, 0.075);
            float band = smoothstep(3.25, 3.3, z) * (1.0 - smoothstep(3.95, 4.0, z));
            col = mix(wallCol, accent, band);
            float sid = h21(vec2(floor(u / cellW) + 0.5, fSeed + 3.0));
            // shop interior: brighter near the top (ceiling lights), dim shelves below
            float interior = 0.45 + 0.55 * smoothstep(0.6, 2.8, z);
            lit = g * uNight * 0.6 * step(0.25, sid) * (0.6 + 0.4 * sid) * interior;
            litCol = mix(vec3(1.0, 0.78, 0.52), vec3(0.92, 0.95, 1.0), step(0.7, sid));
        } else if (!house) {
            // lobby / ground floor windows
            float win = boxAA(vec2(fx, z / groundH), vec2(0.25, 0.25), vec2(0.75, 0.78), vec2(fw.x, fwidth(z / groundH) * 1.2));
            glassMask = win;
        } else {
            float win = boxAA(vec2(fx, z / groundH), vec2(0.28, 0.3), vec2(0.72, 0.75), vec2(fw.x, fwidth(z / groundH) * 1.2));
            glassMask = win;
            float wid = h21(vec2(bay + 0.5, 7.0 + fSeed));
            lit = step(1.0 - 0.5 * uNight, wid) * win * 0.7;
        }
    } else if (z >= fH - parapet && !tower && fStyle < 3.5) {
        // parapet cap line
        col = mix(col, accent, smoothstep(fH - 0.35, fH - 0.3, z) * step(0.5, h11(fSeed * 5.0)) * 0.8);
    }
    glassMask *= detail;
    lit *= mix(0.6, 1.0, detail);
    col = mix(col, glass, glassMask);
    rough = mix(0.85, tower ? 0.06 : 0.1, glassMask);
    // contact darkening at street level
    col *= mix(0.72, 1.0, smoothstep(0.0, 2.5, z));
}
diffuseColor.rgb = col;
float facadeRough = rough;
float facadeGlass = glassMask;
vec3 facadeEmissive = litCol * lit;`)
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = facadeRough;`)
            .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = facadeGlass * 0.35;`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += facadeEmissive * 1.4;`);
    };
    return m;
}
