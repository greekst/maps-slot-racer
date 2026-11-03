// Mapbox layers that paint the slot circuit onto the real street:
// a speed-coloured "racing band" (brake zones glow red), copper rails and the slot,
// plus a chequered start/finish line.

export function speedColor(v) {
    // m/s → colour. Slow corners red, braking orange/yellow, flat-out green → cyan.
    const stops = [
        [0, [255, 45, 85]], [14, [255, 59, 48]], [24, [255, 149, 0]],
        [38, [255, 214, 10]], [58, [48, 209, 88]], [80, [100, 210, 255]],
    ];
    if (v <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        if (v <= stops[i][0]) {
            const [v0, c0] = stops[i - 1], [v1, c1] = stops[i];
            const f = (v - v0) / (v1 - v0);
            return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
        }
    }
    return stops[stops.length - 1][1];
}

const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

// Line widths in Mapbox are pixels at the current zoom; convert real metres to a zoom curve.
function metres(m, lat) {
    const mpp = z => 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** z);
    return ['interpolate', ['exponential', 2], ['zoom'], 12, m / mpp(12), 24, m / mpp(24)];
}

export function addTrackLayers(map, track) {
    const lat = track.proj.lat0;
    map.addSource('track', {
        type: 'geojson',
        lineMetrics: true,
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: track.lngLats } },
    });

    const gradient = ['interpolate', ['linear'], ['line-progress']];
    const STEP = 6;
    for (let s = 0; s <= track.length; s += STEP) {
        gradient.push(Math.min(1, s / track.length), rgb(speedColor(track.lerpArray(track.idealSpeed, s))));
    }
    if (gradient[gradient.length - 2] < 1) gradient.push(1, gradient[gradient.length - 1]);

    const common = { type: 'line', source: 'track', slot: 'middle', layout: { 'line-cap': 'round', 'line-join': 'round' } };
    map.addLayer({
        ...common, id: 'track-band',
        paint: { 'line-width': metres(3.4, lat), 'line-gradient': gradient, 'line-opacity': 0.42, 'line-blur': metres(1.2, lat), 'line-emissive-strength': 1 },
    });
    map.addLayer({
        ...common, id: 'track-rails',
        paint: { 'line-width': metres(0.7, lat), 'line-color': '#d49a5a', 'line-opacity': 0.95, 'line-emissive-strength': 0.9 },
    });
    map.addLayer({
        ...common, id: 'track-slot',
        paint: { 'line-width': metres(0.22, lat), 'line-color': '#0c0c0e', 'line-emissive-strength': 0 },
    });

    // Chequered start/finish: 2 rows × N squares across the road at s = 0
    const p = track.sample(0);
    const fx = Math.sin(p.heading), fy = Math.cos(p.heading);
    const rx = Math.cos(p.heading), ry = -Math.sin(p.heading);
    const SQ = 0.7, COLS = 16;
    const features = [];
    for (let row = 0; row < 2; row++) {
        for (let col = 0; col < COLS; col++) {
            const a = (col - COLS / 2) * SQ, b = row * SQ;
            const corner = (da, db) => track.proj.toLngLat(p.x + rx * (a + da) + fx * (b + db), p.y + ry * (a + da) + fy * (b + db));
            features.push({
                type: 'Feature',
                properties: { dark: (row + col) % 2 === 1 },
                geometry: { type: 'Polygon', coordinates: [[corner(0, 0), corner(SQ, 0), corner(SQ, SQ), corner(0, SQ), corner(0, 0)]] },
            });
        }
    }
    map.addSource('startline', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map.addLayer({
        id: 'startline', type: 'fill', source: 'startline', slot: 'middle',
        paint: { 'fill-color': ['case', ['get', 'dark'], '#111111', '#f4f4f4'], 'fill-emissive-strength': 0.8 },
    });
}

export function setRacingBandVisible(map, visible) {
    map.setLayoutProperty('track-band', 'visibility', visible ? 'visible' : 'none');
}
