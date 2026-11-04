// ─────────────────────────────────────────────────────────────────────────────
//  Slot Racer — real-world slot-car racing on Mapbox GL JS v3
//
//  Frame flow (one rAF):  input → fixed-step physics (240 Hz) → timing →
//  camera (FreeCamera) → HUD/audio. The Three.js custom layer reads the car
//  pose when Mapbox draws, so car and camera are always from the same state.
// ─────────────────────────────────────────────────────────────────────────────

import mapboxgl from 'mapbox-gl';
import './styles.css';
import { MAPBOX_ACCESS_TOKEN, PHYSICS_HZ, TRACK } from './config.js';
import trackDef from './tracks/south-beach.json';
import { Track } from './track.js';
import { SlotCar } from './car.js';
import { ChaseCamera } from './camera.js';
import { CarLayer } from './three-layer.js';
import { addTrackLayers, setRacingBandVisible } from './track-layers.js';
import { LapTimer, formatTime } from './timing.js';
import { Input } from './input.js';
import { RaceAudio } from './audio.js';
import { Hud } from './hud.js';
import { buildCity } from './city/index.js';

mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

const track = new Track(trackDef);
const car = new SlotCar(track);
const timer = new LapTimer(track, 'slotracer:best:south-beach:v1');
const input = new Input();
const audio = new RaceAudio();
const hud = new Hud(track);

const LIGHT_PRESETS = ['dusk', 'night', 'dawn', 'day'];
let lightIndex = 0;
let showGhost = true;
let showBand = true;

// Game state: 'title' | 'countdown' | 'race' | 'paused'
let state = 'title';
let pausedFrom = null;
let clock = 0;               // game time (s), frozen while paused
let countdown = null;        // { t, lightsOutAt, lit }

document.getElementById('track-meta').textContent =
    `${(track.length / 1000).toFixed(2)} km · ${track.corners.length} corners · ${trackDef.description}` +
    (timer.best ? ` · Best ${formatTime(timer.best.time)}` : '');

// ── Map ──────────────────────────────────────────────────────────────────────
const start = track.sample(TRACK.gridOffset);
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/standard',
    config: {
        basemap: {
            lightPreset: LIGHT_PRESETS[lightIndex],
            showPointOfInterestLabels: false,
            showTransitLabels: false,
            showPlaceLabels: false,
            showRoadLabels: false,
            // Our own buildings (src/city) replace Standard's plain extrusions
            show3dBuildings: false,
            show3dLandmarks: false,
        },
    },
    center: track.proj.toLngLat(start.x, start.y),
    zoom: 18,
    pitch: 70,
    bearing: start.heading * 180 / Math.PI,
    interactive: false,
    maxPitch: 85,
    maxZoom: 25.5,
    antialias: true,
    attributionControl: true,
});

// Mapbox floors the camera altitude at the straight-down height of maxZoom (≈1.8–2.5 m
// at 25.5 depending on window height). A chase cam needs to sit lower than that, so lift
// the transform's internal limit. Tiles are unaffected (they just overzoom).
if (typeof map.transform?._maxZoom === 'number') map.transform._maxZoom = 28;

const camera = new ChaseCamera(map, track);
const carLayer = new CarLayer({
    track,
    getCar: () => car,
    getGhost: () => (showGhost && state === 'race' ? timer.ghost(clock) : null),
    getCamera: () => camera,
});

map.on('style.load', () => {
    addTrackLayers(map, track);
    map.addLayer(carLayer);
    camera.update(0, car, { attract: true });
    requestAnimationFrame(frame);
    cityReady = buildCity({ map, track, carLayer, token: MAPBOX_ACCESS_TOKEN })
        .catch(err => { console.warn('[city] failed, falling back to Standard buildings:', err); map.setConfigProperty('basemap', 'show3dBuildings', true); });
});
let cityReady = null;
// The map never goes 'idle' (we repaint every frame), so drop the loader once tiles have arrived
map.once('style.load', () => setTimeout(() => document.getElementById('loading').classList.add('done'), 1200));

function setLight(p) {
    lightIndex = Math.max(0, LIGHT_PRESETS.indexOf(p));
    p = LIGHT_PRESETS[lightIndex];
    map.setConfigProperty('basemap', 'lightPreset', p);
    carLayer.setLightPreset(p);
    return p;
}

// ── Controls ─────────────────────────────────────────────────────────────────
function beginRace() {
    audio.init();
    document.getElementById('title').classList.add('hidden');
    document.body.classList.remove('attract');
    car.reset(TRACK.gridOffset);
    timer.reset();
    hud.clearSectors();
    camera.snap();
    state = 'countdown';
    countdown = { t: 0, lit: 0, lightsOutAt: 5 + 0.4 + Math.random() * 1.6 };
    hud.setLights(0);
}

function togglePause() {
    if (state === 'paused') {
        state = pausedFrom;
        document.getElementById('pause').classList.add('hidden');
        audio.ctx?.resume();
    } else if (state === 'race' || state === 'countdown') {
        pausedFrom = state;
        state = 'paused';
        document.getElementById('pause').classList.remove('hidden');
        audio.ctx?.suspend();
    }
}

input.on('key', code => {
    switch (code) {
        case 'Space': case 'Enter':
            if (state === 'title') beginRace();
            else if (state === 'paused') togglePause();
            break;
        case 'Escape': case 'KeyP': togglePause(); break;
        case 'KeyR': if (state !== 'title') { if (state === 'paused') togglePause(); beginRace(); } break;
        case 'KeyC': hud.toast(`Camera: ${camera.cycle()}`); camera.snap(); break;
        case 'KeyG': showGhost = !showGhost; hud.toast(`Ghost ${showGhost ? 'on' : 'off'}`); break;
        case 'KeyH': showBand = !showBand; setRacingBandVisible(map, showBand); hud.toast(`Racing line ${showBand ? 'on' : 'off'}`); break;
        case 'KeyU': hud.setUnits(hud.units === 'kmh' ? 'mph' : 'kmh'); hud.toast(`Units: ${hud.unitLabel()}`); break;
        case 'KeyM': audio.setMuted(!audio.muted); hud.toast(audio.muted ? 'Sound off' : 'Sound on'); break;
        case 'KeyL': {
            const p = setLight(LIGHT_PRESETS[(lightIndex + 1) % LIGHT_PRESETS.length]);
            hud.toast(`Time of day: ${p}`);
            break;
        }
    }
});
input.on('blur', () => { if (state === 'race' || state === 'countdown') togglePause(); });
document.getElementById('start-btn').addEventListener('click', () => state === 'title' && beginRace());
document.getElementById('resume-btn').addEventListener('click', togglePause);
document.getElementById('reset-best-btn').addEventListener('click', () => { timer.clearBest(); hud.toast('Best lap cleared'); });

// ── Main loop ────────────────────────────────────────────────────────────────
const STEP = 1 / PHYSICS_HZ;
let last = performance.now();
let acc = 0;

function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt);
}

function tick(dt) {
    const controls = input.update(dt);

    if (state === 'paused') return;

    if (state === 'title') {
        car.throttle = 0; car.brake = 0;
        camera.update(dt, car, { attract: true });
        map.triggerRepaint();
        return;
    }

    if (state === 'countdown') tickCountdown(dt);

    const live = state === 'race';
    acc += dt;
    while (acc >= STEP) {
        car.step(STEP, controls, live);
        clock += STEP;
        if (live) timer.update(clock, car);
        acc -= STEP;
    }

    handleEvents();
    camera.update(dt, car);
    hud.update({ car, timer, t: clock, ghost: showGhost ? timer.ghost(clock) : null });
    audio.update({ rpm: car.rpm, throttle: car.throttle, slip: car.slip, speed: car.v, active: true });
    map.triggerRepaint();
}

function tickCountdown(dt) {
    countdown.t += dt;
    const lit = Math.min(5, Math.floor(countdown.t));
    if (lit > countdown.lit) {
        countdown.lit = lit;
        hud.setLights(lit);
        audio.beep(440, 0.16);
    }
    if (countdown.t >= countdown.lightsOutAt) {
        hud.setLights(-1);
        state = 'race';
        timer.start(clock);
        audio.beep(880, 0.4, 0.3);
        hud.message('GO!', { cls: 'go', ms: 900 });
    }
}

function handleEvents() {
    for (const e of car.events.splice(0)) {
        if (e.type === 'deslot') {
            audio.crash();
            camera.kick(0.35);
            timer.deslotsThisLap++;
            hud.message('DE-SLOTTED!', { cls: 'bad', sub: `${Math.round(hud.speedIn(e.speed))} ${hud.unitLabel()} — too hot`, ms: 1600 });
        } else if (e.type === 'shift' && e.dir > 0) {
            audio.shift();
        }
    }
    for (const e of timer.events.splice(0)) {
        if (e.type === 'sector') hud.sector(e.index, e.time, e.best);
        if (e.type === 'lap') {
            hud.clearSectors();
            if (e.isBest && e.prevBest != null) {
                hud.message('NEW BEST LAP', { cls: 'best', sub: `${formatTime(e.time)}  (${formatTime(e.time - e.prevBest, { sign: true })})`, ms: 2600 });
            } else {
                hud.message(`LAP ${e.lap}`, { sub: formatTime(e.time) + (e.deslots ? ` · ${e.deslots} off` : ''), ms: 2000 });
            }
        }
    }
}

document.body.classList.add('attract');

// Debug handle for the console
window.__slot = {
    map, track, car, timer, camera, carLayer, mapboxgl,
    get city() { return cityReady; },
    setLight,
    // Advance the game by `sec` seconds without rAF (for headless/hidden-tab testing)
    advance(sec, fps = 60) { for (let i = 0; i < sec * fps; i++) tick(1 / fps); },
};
