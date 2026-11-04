// Street surface detail as Mapbox layers: asphalt, curbs, sidewalks, lane markings
// and zebra crosswalks, generated from Mapbox Streets road geometry.
//
// Lane counts aren't in the data, so they come from road class and one-way flag
// (South Beach: Collins/Washington/5th are wide arterials; side streets are 2-lane).
// Markings are offset in JS (exact metres) and trimmed back from intersections.

import { metres } from '../track-layers.js';

// Full carriageway width (m) and lanes per direction (two-way) or total (one-way)
const ROADS = {
    motorway: { w: 22, lanes: 3, oneLanes: 3 },
    trunk: { w: 18, lanes: 3, oneLanes: 3 },
    primary: { w: 15, lanes: 2, oneLanes: 3 },
    secondary: { w: 13, lanes: 2, oneLanes: 3 },
    tertiary: { w: 11, lanes: 1, oneLanes: 2 },
    street: { w: 9, lanes: 1, oneLanes: 2 },
    street_limited: { w: 7, lanes: 1, oneLanes: 1, noMarks: true },
    service: { w: 5, lanes: 1, oneLanes: 1, noMarks: true },
};
const LINK = { motorway_link: 'service', trunk_link: 'tertiary', primary_link: 'tertiary', secondary_link: 'tertiary', tertiary_link: 'street' };

function spec(r) {
    if (r.structure === 'tunnel') return null;
    if (r.class === 'service' && /parking_aisle|drive_through|driveway/.test(r.type || '')) return { ...ROADS.service, w: 4 };
    return ROADS[LINK[r.class] || r.class] || null;
}

// Offset a polyline sideways by d metres (+ = right of travel direction)
function offsetLine(c, d) {
    const out = [];
    for (let i = 0; i < c.length; i++) {
        const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
        let tx = b[0] - a[0], ty = b[1] - a[1];
        const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
        // right normal of (tx, ty) in x-East/y-North is (ty, -tx)
        let nx = ty, ny = -tx, k = 1;
        if (i > 0 && i < c.length - 1) {
            // miter: scale by 1/cos(half-angle), capped
            const ax = c[i][0] - c[i - 1][0], ay = c[i][1] - c[i - 1][1];
            const La = Math.hypot(ax, ay) || 1;
            const n1x = ay / La, n1y = -ax / La;
            const cos = nx * n1x + ny * n1y;
            k = 1 / Math.max(0.5, cos);
        }
        out.push([c[i][0] + nx * d * k, c[i][1] + ny * d * k]);
    }
    return out;
}

// Split a polyline into the parts farther than `r(node)` from every intersection node
function trim(coords, near) {
    const runs = [];
    let cur = [];
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(L / 1.5));
        for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
            const t = k / n, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            if (near(p[0], p[1])) { if (cur.length > 1) runs.push(cur); cur = []; }
            else cur.push(p);
        }
    }
    if (cur.length > 1) runs.push(cur);
    return runs;
}

function gridIndex(points, cell) {
    const g = new Map();
    for (const p of points) {
        const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(p);
    }
    return (x, y) => {
        const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const p of g.get(`${gx + dx},${gy + dy}`) || []) {
                if ((p.x - x) ** 2 + (p.y - y) ** 2 < p.r * p.r) return true;
            }
        }
        return false;
    };
}

export function buildRoadData(city, proj) {
    const toLL = c => c.map(([x, y]) => proj.toLngLat(x, y));
    const car = city.roads.map(r => ({ r, s: spec(r) })).filter(o => o.s && o.r.coords.length > 1);

    // Intersection nodes: any vertex shared by two or more road features (roads often pass
    // straight through a junction without ending there). Tile-border splits of one road
    // share an endpoint with the same name and only two ends, so they are skipped.
    const verts = new Map();
    car.forEach(({ r, s }, fi) => {
        if (s.w < 5) return;
        r.coords.forEach((p, vi) => {
            const k = `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
            if (!verts.has(k)) verts.set(k, { x: p[0], y: p[1], feats: new Set(), names: new Set(), interior: false, w: 0 });
            const e = verts.get(k);
            e.feats.add(fi); e.names.add(r.name); e.w = Math.max(e.w, s.w);
            if (vi > 0 && vi < r.coords.length - 1) e.interior = true;
        });
    });
    const nodes = [];
    for (const e of verts.values()) {
        const n = e.feats.size;
        if (n >= 3 || (n === 2 && (e.names.size > 1 || e.interior))) nodes.push({ x: e.x, y: e.y, r: e.w * 0.5 + 3 });
    }
    const near = gridIndex(nodes, 20);

    const asphalt = [], marks = [], sidewalks = [], crossings = [];
    for (const { r, s } of car) {
        asphalt.push({ type: 'Feature', properties: { w: s.w }, geometry: { type: 'LineString', coordinates: toLL(r.coords) } });
        if (s.noMarks || r.structure === 'bridge' && r.class === 'service') continue;
        const half = s.w / 2;
        const add = (d, kind) => {
            for (const run of trim(offsetLine(r.coords, d), near)) {
                marks.push({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: toLL(run) } });
            }
        };
        // edge lines
        add(half - 0.45, 'edge'); add(-(half - 0.45), 'edge');
        if (r.oneway) {
            const n = s.oneLanes, lw = (s.w - 0.9) / n;
            for (let i = 1; i < n; i++) add(-half + 0.45 + lw * i, 'dash');
        } else {
            add(0.13, 'yellow'); add(-0.13, 'yellow');
            const n = s.lanes, lw = (half - 0.45) / n;
            for (let i = 1; i < n; i++) { add(lw * i, 'dash'); add(-lw * i, 'dash'); }
        }
    }
    for (const r of city.roads) {
        if (r.class !== 'path' || r.coords.length < 2) continue;
        if (r.type === 'sidewalk') sidewalks.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: toLL(r.coords) } });
        else if (r.type === 'crossing') crossings.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: toLL(r.coords) } });
    }
    const fc = features => ({ type: 'FeatureCollection', features });
    return { asphalt: fc(asphalt), marks: fc(marks), sidewalks: fc(sidewalks), crossings: fc(crossings) };
}

export function addRoadLayers(map, data, lat, beforeId) {
    for (const [id, d] of Object.entries(data)) map.addSource(`city-${id}`, { type: 'geojson', data: d });
    const common = { type: 'line', slot: 'middle', layout: { 'line-cap': 'butt', 'line-join': 'round' } };
    const width = (base, extra = 0) => ['interpolate', ['exponential', 2], ['zoom'],
        12, ['*', ['+', ['get', 'w'], extra], base[0]], 24, ['*', ['+', ['get', 'w'], extra], base[1]]];
    // metres() as [z12 px/m, z24 px/m] so it can be multiplied by a feature property
    const m1 = metres(1, lat);
    const pxPerM = [m1[4], m1[6]];
    const layers = [
        // sidewalks first (under asphalt edges), then curb, asphalt, markings, crosswalks
        { ...common, id: 'city-sidewalk', source: 'city-sidewalks', layout: { ...common.layout, 'line-cap': 'round' },
            paint: { 'line-color': '#c9c4ba', 'line-width': metres(2.6, lat), 'line-emissive-strength': 0 } },
        { ...common, id: 'city-curb', source: 'city-asphalt', layout: { ...common.layout, 'line-cap': 'round' },
            paint: { 'line-color': '#dcd8d0', 'line-width': width(pxPerM, 0.7), 'line-emissive-strength': 0 } },
        { ...common, id: 'city-asphalt', source: 'city-asphalt', layout: { ...common.layout, 'line-cap': 'round' },
            paint: { 'line-color': '#3b3c40', 'line-width': width(pxPerM), 'line-emissive-strength': 0 } },
        { ...common, id: 'city-mark-edge', source: 'city-marks', filter: ['==', ['get', 'kind'], 'edge'],
            paint: { 'line-color': '#e9e7e1', 'line-width': metres(0.14, lat), 'line-emissive-strength': 0.2 } },
        { ...common, id: 'city-mark-dash', source: 'city-marks', filter: ['==', ['get', 'kind'], 'dash'],
            paint: { 'line-color': '#ecebe6', 'line-width': metres(0.13, lat), 'line-dasharray': [23, 69], 'line-emissive-strength': 0.2 } },
        { ...common, id: 'city-mark-yellow', source: 'city-marks', filter: ['==', ['get', 'kind'], 'yellow'],
            paint: { 'line-color': '#e8b923', 'line-width': metres(0.12, lat), 'line-emissive-strength': 0.2 } },
        { ...common, id: 'city-crosswalk', source: 'city-crossings',
            paint: { 'line-color': '#efeee9', 'line-width': metres(3.0, lat), 'line-dasharray': [0.2, 0.2], 'line-emissive-strength': 0.2 } },
    ];
    for (const l of layers) map.addLayer(l, beforeId);
}
