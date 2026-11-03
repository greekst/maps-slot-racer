// ─────────────────────────────────────────────────────────────────────────────
//  Maps Racing Sim — main.js
//  Engine: Mapbox GL JS v3  |  Style: Standard (Apple Maps-like)
//  Physics: v1 — direct acceleration, exponential drag, speed-proportional steering
//  Camera:  v1 — rigid jumpTo lock, zero look-ahead offset
// ─────────────────────────────────────────────────────────────────────────────

import { MAPBOX_ACCESS_TOKEN, STARTING_LOCATION } from './config.js';

// ── Mapbox token ──────────────────────────────────────────────────────────────
mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_SPEED    = 0.0002;   // max speed in lat/lng units per frame
const ACCEL        = 0.000005; // throttle acceleration per frame
const DRAG         = 0.98;     // exponential drag multiplier when coasting
const TURN_RATE    = 2.5;      // degrees per frame at full speed
const LAT_LNG_SCALE = 0.00001; // metres-to-degrees scale for position integration

// ── Vehicle state ─────────────────────────────────────────────────────────────
let lng     = STARTING_LOCATION.lng;
let lat     = STARTING_LOCATION.lat;
let heading = 0;     // degrees, 0 = True North, clockwise
let speed   = 0;     // current speed in lat/lng units per frame

// ── Keyboard state ────────────────────────────────────────────────────────────
const keys = { w: false, a: false, s: false, d: false };

window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k in keys) { keys[k] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k in keys) keys[k] = false;
});

// ── HUD references ────────────────────────────────────────────────────────────
const hudSpeed   = document.getElementById('hud-speed');
const hudHeading = document.getElementById('hud-heading');

// ── Map initialisation ────────────────────────────────────────────────────────
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/standard',
    center: [STARTING_LOCATION.lng, STARTING_LOCATION.lat],
    zoom: 19.2,
    pitch: 75,
    bearing: 0,
    antialias: true,
    interactive: false,
    maxPitch: 85
});

// ── Style load ────────────────────────────────────────────────────────────────
map.on('style.load', () => {

    // ── Environment ───────────────────────────────────────────────────────────
    map.setConfigProperty('basemap', 'lightPreset', 'dusk');
    map.setConfigProperty('basemap', 'showPointOfInterestLabels', false);
    map.setConfigProperty('basemap', 'showTransitLabels', false);

    // ── GeoJSON source — single Feature anchors the model ────────────────────
    map.addSource('car-source', {
        type: 'geojson',
        data: buildCarGeoJSON(lng, lat, heading)
    });

    // ── Load local GLB asset ──────────────────────────────────────────────────
    map.addModel('car-model', window.location.origin + '/car.glb');

    // ── Model layer ───────────────────────────────────────────────────────────
    map.addLayer({
        id: 'car-layer',
        type: 'model',
        source: 'car-source',
        layout: {
            'model-id': 'car-model',
            'model-rotation': [0, 0, ['get', 'modelRotationZ']]
        },
        paint: {
            'model-scale': [4, 4, 4],
            'model-cast-shadows': true,
            'model-receive-shadows': true,
            'model-opacity': 1.0,
            'model-ambient-occlusion-intensity': 0.8,
            'model-emissive-strength': 0
        }
    });

    // ── Render loop ───────────────────────────────────────────────────────────
    function tick() {
        requestAnimationFrame(tick);

        // ── Throttle / Brake ──────────────────────────────────────────────────
        if (keys.w) {
            speed += ACCEL;
        } else if (keys.s) {
            speed -= ACCEL;
        } else {
            // Exponential drag — car coasts to a stop naturally
            speed *= DRAG;
            if (Math.abs(speed) < 0.000001) speed = 0;
        }

        // Hard clamp
        speed = Math.max(-MAX_SPEED * 0.5, Math.min(MAX_SPEED, speed));

        // ── Steering — speed-proportional, can't steer at standstill ─────────
        const speedFactor = Math.abs(speed) / MAX_SPEED;
        if (speedFactor > 0.01) {
            const turnSign = speed >= 0 ? 1 : -1;
            if (keys.a) heading -= TURN_RATE * speedFactor * turnSign;
            if (keys.d) heading += TURN_RATE * speedFactor * turnSign;
            heading = ((heading % 360) + 360) % 360;
        }

        // ── Position update — True North convention ───────────────────────────
        // sin/cos on compass heading: 0° = North, 90° = East (matches Mapbox bearing).
        const rad = heading * (Math.PI / 180);
        lng += Math.sin(rad) * speed;
        lat += Math.cos(rad) * speed;

        // ── Model update ──────────────────────────────────────────────────────
        const src = map.getSource('car-source');
        if (src) src.setData(buildCarGeoJSON(lng, lat, heading));

        // ── Rigid chase camera — zero offset, locked to rear bumper ──────────
        map.jumpTo({
            center:  [lng, lat],
            bearing: heading,
            pitch:   75,
            zoom:    19.2
        });

        // ── HUD ───────────────────────────────────────────────────────────────
        // Convert lat/lng-unit speed to approximate km/h for display
        const speedKmh = Math.abs(speed) / MAX_SPEED * 72;
        hudSpeed.textContent   = Math.round(speedKmh);
        hudHeading.textContent = Math.round(heading);
    }

    requestAnimationFrame(tick);
});

// ── Helper: GeoJSON Feature with mesh rotation ────────────────────────────────
//
//  Mapbox model-rotation Z is CCW from East (degrees).
//  Our heading is CW from North (Mapbox bearing convention).
//
//  Try 1:  modelRotationZ = -heading + 90    (nose forward)
//  Try 2:  modelRotationZ = -heading - 90    (nose backward — flip if Try 1 wrong)
//
function buildCarGeoJSON(lng, lat, headingDeg = 0) {
    const modelRotationZ = -headingDeg + 90;   // swap to -heading - 90 if reversed

    return {
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [lng, lat]
        },
        properties: { modelRotationZ }
    };
}
