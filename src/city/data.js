// City data around the circuit, read from Mapbox Streets v8 vector tiles at runtime.
//
// Mapbox Standard's own buildings are plain extrusions here (no facade or HD-road
// coverage in Miami Beach), so we fetch the same vector data and build richer
// geometry ourselves. Nothing is stored in the repo: tiles are fetched with the
// user's token like any other map tile (and cached by the browser).
//
// Output is in track metres (x East, y North; see geo.js), clipped to exact tile
// bounds so features split across tiles don't overlap.

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const Z = 16;                       // max zoom of mapbox-streets-v8 (full detail)
const TILESET = 'mapbox.mapbox-streets-v8';

const lng2x = (lng, z) => (lng + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;
const x2lng = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };

// Cheap deterministic hash → [0,1)
export function hash01(n) {
    let h = (n | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Sutherland–Hodgman against [0,E]² (tile coords)
function clipRing(ring, E) {
    let out = ring;
    const edges = [
        p => p.x >= 0, p => p.x <= E, p => p.y >= 0, p => p.y <= E,
    ];
    const inter = [
        (a, b) => ({ x: 0, y: a.y + (b.y - a.y) * (0 - a.x) / (b.x - a.x) }),
        (a, b) => ({ x: E, y: a.y + (b.y - a.y) * (E - a.x) / (b.x - a.x) }),
        (a, b) => ({ x: a.x + (b.x - a.x) * (0 - a.y) / (b.y - a.y), y: 0 }),
        (a, b) => ({ x: a.x + (b.x - a.x) * (E - a.y) / (b.y - a.y), y: E }),
    ];
    for (let e = 0; e < 4; e++) {
        const inp = out; out = [];
        if (!inp.length) break;
        for (let i = 0; i < inp.length; i++) {
            const a = inp[(i - 1 + inp.length) % inp.length], b = inp[i];
            const ain = edges[e](a), bin = edges[e](b);
            if (bin) { if (!ain) out.push(inter[e](a, b)); out.push(b); }
            else if (ain) out.push(inter[e](a, b));
        }
    }
    return out;
}

// Clip a polyline to [0,E]², returning the inside runs
function clipLine(line, E) {
    const runs = [];
    let cur = null;
    for (let i = 1; i < line.length; i++) {
        let a = line[i - 1], b = line[i];
        let t0 = 0, t1 = 1;
        const dx = b.x - a.x, dy = b.y - a.y;
        let ok = true;
        for (const [p, q] of [[-dx, a.x], [dx, E - a.x], [-dy, a.y], [dy, E - a.y]]) {
            if (p === 0) { if (q < 0) { ok = false; break; } continue; }
            const r = q / p;
            if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
            else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
        }
        if (!ok) { cur = null; continue; }
        const pa = { x: a.x + dx * t0, y: a.y + dy * t0 }, pb = { x: a.x + dx * t1, y: a.y + dy * t1 };
        if (!cur || t0 > 0) { cur = [pa]; runs.push(cur); }
        cur.push(pb);
        if (t1 < 1) cur = null;
    }
    return runs.filter(r => r.length > 1);
}

const signedArea = r => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x - r[i].x) * (r[i].y + r[j].y); return s; };

// Group MVT rings into polygons [outer, ...holes] (first ring's winding = outer)
function classifyRings(rings) {
    const polys = [];
    let poly = null, ccw;
    for (const r of rings) {
        const a = signedArea(r);
        if (a === 0) continue;
        if (ccw === undefined) ccw = a < 0;
        if (ccw === (a < 0)) { poly = [r]; polys.push(poly); }
        else if (poly) poly.push(r);
    }
    return polys;
}

async function fetchTile(x, y, token) {
    const url = `https://api.mapbox.com/v4/${TILESET}/${Z}/${x}/${y}.vector.pbf?access_token=${token}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`tile ${Z}/${x}/${y}: HTTP ${r.status}`);
    return new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
}

// bbox [w,s,e,n] in lng/lat. proj: track projection (toXY).
export async function loadCity({ bbox, proj, token }) {
    const [w, s, e, n] = bbox;
    const x0 = Math.floor(lng2x(w, Z)), x1 = Math.floor(lng2x(e, Z));
    const y0 = Math.floor(lat2y(n, Z)), y1 = Math.floor(lat2y(s, Z));
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push({ x, y });

    const city = { buildings: [], roads: [], signals: [], crosswalks: [], stops: [], pois: [], landuse: [], tiles: jobs.length };
    const tiles = await Promise.all(jobs.map(j => fetchTile(j.x, j.y, token).then(t => ({ ...j, t }), err => { console.warn(err.message); return null; })));

    for (const tile of tiles) {
        if (!tile) continue;
        const { x: tx, y: ty, t } = tile;
        const toXY = (p, E) => {
            const lng = x2lng(tx + p.x / E, Z), lat = y2lat(ty + p.y / E, Z);
            return proj.toXY(lng, lat);
        };

        const L = t.layers;
        if (L.building) {
            const E = L.building.extent;
            for (let i = 0; i < L.building.length; i++) {
                const f = L.building.feature(i);
                const p = f.properties;
                if (p.underground === 'true' || p.underground === true) continue;
                for (const poly of classifyRings(f.loadGeometry())) {
                    const rings = poly.map(r => clipRing(r, E)).filter(r => r.length >= 3)
                        .map(r => r.map(pt => toXY(pt, E)));
                    if (!rings.length || ringArea(rings[0]) < 4) continue;
                    city.buildings.push({
                        rings,
                        h: +p.height || 3,
                        mh: +p.min_height || 0,
                        type: p.type || 'building',
                        id: +p.building_id || Math.floor(rings[0][0][0] * 1000 + rings[0][0][1]),
                    });
                }
            }
        }
        if (L.road) {
            const E = L.road.extent;
            for (let i = 0; i < L.road.length; i++) {
                const f = L.road.feature(i);
                const p = f.properties;
                const g = f.loadGeometry();
                if (f.type === 1) {
                    // Point features: traffic signals, stop signs, crossings
                    for (const ring of g) for (const pt of ring) {
                        if (pt.x < 0 || pt.y < 0 || pt.x > E || pt.y > E) continue;
                        const xy = toXY(pt, E);
                        if (p.class === 'traffic_signals') city.signals.push(xy);
                    }
                    continue;
                }
                if (f.type !== 2) continue;
                for (const line of g) {
                    for (const run of clipLine(line, E)) {
                        city.roads.push({
                            coords: run.map(pt => toXY(pt, E)),
                            class: p.class, type: p.type, oneway: p.oneway === 'true' || p.oneway === true,
                            structure: p.structure, name: p.name || '', layer: +p.layer || 0,
                        });
                    }
                }
            }
        }
        if (L.structure) {
            const E = L.structure.extent;
            for (let i = 0; i < L.structure.length; i++) {
                const f = L.structure.feature(i);
                if (f.type !== 1 || f.properties.class !== 'crosswalk') continue;
                for (const ring of f.loadGeometry()) for (const pt of ring) {
                    if (pt.x < 0 || pt.y < 0 || pt.x > E || pt.y > E) continue;
                    city.crosswalks.push([...toXY(pt, E), +f.properties.direction || 0]);
                }
            }
        }
        if (L.transit_stop_label) {
            const E = L.transit_stop_label.extent;
            for (let i = 0; i < L.transit_stop_label.length; i++) {
                const f = L.transit_stop_label.feature(i);
                if (f.properties.mode !== 'bus') continue;
                const pt = f.loadGeometry()[0][0];
                if (pt.x < 0 || pt.y < 0 || pt.x > E || pt.y > E) continue;
                city.stops.push(toXY(pt, E));
            }
        }
        if (L.poi_label) {
            const E = L.poi_label.extent;
            for (let i = 0; i < L.poi_label.length; i++) {
                const f = L.poi_label.feature(i);
                const pt = f.loadGeometry()[0][0];
                if (pt.x < 0 || pt.y < 0 || pt.x > E || pt.y > E) continue;
                const p = f.properties;
                city.pois.push({ xy: toXY(pt, E), name: p.name, maki: p.maki, rank: +p.sizerank || 16 });
            }
        }
    }
    return city;
}

export function ringArea(r) {
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(s / 2);
}

// Track bbox in lng/lat, padded by `pad` metres
export function trackBBox(track, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < track.n; i++) {
        x0 = Math.min(x0, track.x[i]); x1 = Math.max(x1, track.x[i]);
        y0 = Math.min(y0, track.y[i]); y1 = Math.max(y1, track.y[i]);
    }
    const [w, s] = track.proj.toLngLat(x0 - pad, y0 - pad);
    const [e, n] = track.proj.toLngLat(x1 + pad, y1 + pad);
    return [w, s, e, n];
}
