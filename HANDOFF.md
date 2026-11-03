# Maps Racing Sim v1 — Claude Code Handoff

## Project Goal

Build a **browser-based, real-world driving simulator** that runs on top of Mapbox GL JS v3. The player drives a 3D vehicle through a real map of Miami Beach (Collins Ave) using WASD keys, with a chase camera locked behind the car. The aesthetic target is **Apple Maps / CarPlay** — clean vector buildings, dusk lighting, no UI clutter.

This is a solo-dev prototype being iterated fast. Prioritize working physics and visual correctness over code elegance. The next milestone is getting a correctly-oriented vehicle driving smoothly on the map so we can begin defining circuit boundaries and lap logic.

---

## Repository

```
/Users/greekst/Desktop/ANTIGRAVITY/Maps_Racing_Sim_v1/
├── index.html          # Full-screen map container + HUD overlay
├── main.js             # All physics, map init, model loading, render loop
├── config.js           # Mapbox token + starting coordinates
├── package.json        # Vite dev server (npm run dev)
├── public/
│   └── car.glb         # Local 3D vehicle mesh (Cesium Milk Truck)
└── node_modules/       # Vite + legacy deps (Three.js, Cannon-es — unused)
```

**Run the project:**
```bash
cd /Users/greekst/Desktop/ANTIGRAVITY/Maps_Racing_Sim_v1
npm run dev
# Opens at http://localhost:5173
```

> **Note on Node:** Node is installed via nvm at `~/.nvm/versions/node/v24.21.0/`. If `npx`/`npm` aren't on PATH, run `nvm use 24` first, or use the full path: `~/.nvm/versions/node/v24.21.0/bin/npm run dev`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Map engine | **Mapbox GL JS v3.0.0** (loaded via CDN in `index.html`) |
| 3D model | Mapbox `addModel` + `addLayer` type `'model'` |
| Style | `mapbox://styles/mapbox/standard` (Apple Maps-like) |
| Build tool | **Vite 5** (`npm run dev`) |
| Vehicle mesh | `public/car.glb` — Cesium Milk Truck (placeholder) |
| Token | `.env` → `VITE_MAPBOX_TOKEN`, read in `src/config.js` |

---

## Architecture — Current State of Each File

### `index.html`
- Imports Mapbox GL JS v3 CSS + JS from CDN in `<head>`
- Full-screen `<div id="map">`
- Apple-style frosted-glass HUD (`#hud`) at bottom-center showing **Speed (km/h)** and **Heading (°)**
- Controls hint overlay top-right: W/A/S/D legend
- Loads `./main.js` as `type="module"`

### `config.js`
```js
export const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN; // from .env
export const STARTING_LOCATION = { lat: 25.7906, lng: -80.1300 }; // Collins Ave, Miami Beach
```

### `main.js` — Current Implementation
```js
// Constants (frame-rate dependent — needs dt-based refactor)
const MAX_SPEED    = 0.0002;   // lat/lng units per frame
const ACCEL        = 0.000005; // throttle per frame
const DRAG         = 0.98;     // exponential drag
const TURN_RATE    = 2.5;      // degrees per frame at max speed

// Vehicle state
let lng, lat, heading, speed;

// Physics loop (requestAnimationFrame — NOT dt-based)
// W/S → speed ± ACCEL
// Coast → speed *= 0.98
// A/D → heading ± TURN_RATE * (speed/MAX_SPEED)

// Position update (True North convention)
const rad = heading * (Math.PI / 180);
lng += Math.sin(rad) * speed;
lat += Math.cos(rad) * speed;

// Model rotation (visual only, decoupled from movement)
modelRotationZ = -heading + 90;  // Mapbox CCW-from-East convention

// Camera (rigid, zero offset)
map.jumpTo({ center: [lng, lat], bearing: heading, pitch: 75, zoom: 19.2 });
```

### Map Setup
```js
new mapboxgl.Map({
    style: 'mapbox://styles/mapbox/standard',
    center: [-80.1300, 25.7906],
    zoom: 19.2, pitch: 75, bearing: 0,
    interactive: false,   // all camera is manual
    maxPitch: 85
});

// style.load callback:
map.setConfigProperty('basemap', 'lightPreset', 'dusk');
map.addSource('car-source', { type: 'geojson', data: Feature<Point> });
map.addModel('car-model', window.location.origin + '/car.glb');
map.addLayer({ id: 'car-layer', type: 'model', source: 'car-source',
    layout: { 'model-id': 'car-model', 'model-rotation': [0, 0, ['get', 'modelRotationZ']] },
    paint:  { 'model-scale': [4, 4, 4], ... }
});
```

---

## Full History of Issues & What Was Tried

### Phase 1 — CesiumJS (Abandoned)
- **Original stack:** CesiumJS + Google Photorealistic 3D Tiles
- **Problem:** CesiumJS `Viewer` is extremely heavy, poor framerate for driving physics, API is designed for GIS not games
- **Decision:** Complete pivot to Mapbox GL JS v3 for vector-based, high-framerate rendering

### Phase 2 — Mapbox Integration

#### Issue 1: `car.glb` silently failing to load
- **Root cause:** Relative path `'./public/car.glb'` was being mangled by Vite's module resolver
- **Fix:** Changed to absolute URL: `window.location.origin + '/car.glb'`
- Vite serves `public/` at the root, so `/car.glb` resolves correctly

#### Issue 2: Model not appearing even with correct URL
- **Root cause (multi-part):**
  1. `addSource` was being fed a `FeatureCollection` — Mapbox v3 model layers require a bare `Feature`
  2. `'model-scale'` was `[1.5, 1.5, 1.5]` — the Milk Truck mesh is very small in its native units
- **Fix:** Changed source data to a single `Feature<Point>` and bumped `'model-scale'` to `[50, 50, 50]` to confirm render, then dialed back to `[4, 4, 4]`

#### Issue 3: Model orientation — truck sideways / backwards
- **Root cause:** The Cesium Milk Truck's native mesh faces **+X (East)** in its local space. Mapbox model-rotation Z is **CCW from East** in degrees. Our `heading` is **CW from North** (Mapbox bearing convention). These three reference frames don't align.
- **Attempts made:**
  - `90 - heading` — wrong
  - `90 - heading + 180` — wrong (still visually backwards)
  - `heading - 90` — wrong
  - `(180 - heading) + 90` (= `270 - heading`) — per Cesium docs, still unresolved
  - **Current formula:** `-heading + 90` (try `-heading - 90` if nose points wrong way)
- **Status: UNRESOLVED** — this is the primary task for Claude Code to nail definitively

#### Issue 4: Car moving diagonally (crabbing)
- **Root cause:** Earlier iterations had `lat += Math.sin(rad) * speed` and `lng += Math.cos(rad) * speed` — swapped axes
- **Fix:** Correct True North mapping is:
  ```js
  lng += Math.sin(rad) * speed;  // East/West
  lat += Math.cos(rad) * speed;  // North/South
  ```
- **Status: RESOLVED** in current code

#### Issue 5: Camera desync
- **Attempted fix 1:** Look-ahead offset — projected center point 13m ahead of car along heading. This caused the camera to lag behind the model update by one frame.
- **Attempted fix 2:** Damped camera lerp with `camLat`/`camLng` state — over-engineered, still felt floaty
- **Final resolution:** Rigid `map.jumpTo({ center: [lng, lat] })` called at the end of every frame after `setData`. Zero offset.
- **Status: RESOLVED** in current code

#### Issue 6: Frame-rate dependent physics
- **Current problem:** Physics constants (`ACCEL`, `DRAG`, `TURN_RATE`, `MAX_SPEED`) are defined in **lat/lng units per frame**, not per second. On a 120Hz display the car accelerates twice as fast as on 60Hz.
- **What was tried:** A `dt`-based physics pass using `performance.now()` with `m/s` units and `LAT_DEG_PER_M`/`LNG_DEG_PER_M` conversion factors. This introduced the diagonal crabbing bug and was reverted.
- **Status: UNRESOLVED** — needs a clean dt-based rewrite

#### Issue 7: Bicycle kinematic model attempt
- **Attempted:** A proper steering model where `steeringAngle` drives heading via `ω = (v/L) × tan(δ)`. Felt better for physics but broke alongside the dt-refactor.
- **Status: REVERTED** — current code uses simple speed-proportional heading addition

#### Issue 8: Lerp-damped inputs
- **Attempted:** `smoothAccel` and `smoothSteer` with lerp rates. Added perceptual polish but introduced jerkiness when combined with the frame-rate-dependent physics
- **Status: REVERTED** — current code uses direct instantaneous input

---

## What's Working Right Now

✅ Mapbox Standard style rendering beautifully (dusk, 3D buildings, Miami Beach)  
✅ `car.glb` loading and rendering at scale `[4, 4, 4]`  
✅ WASD input captured correctly  
✅ Speed-proportional steering (can't turn at standstill)  
✅ Exponential drag (coasts to stop)  
✅ Forward/reverse movement along True North heading  
✅ Rigid chase camera locked to `[lng, lat]` at pitch 75, zoom 19.2  
✅ HUD showing speed (km/h) and heading (degrees)  
✅ Dusk lighting preset  

---

## What Needs to Be Fixed (Priority Order)

### 🔴 P0 — Model Orientation
The truck mesh is rendering but we have never definitively confirmed the nose is pointing in the direction of travel. The `modelRotationZ` formula needs to be verified with the specific Cesium Milk Truck GLB.

**Recommended approach:**
1. Open the GLB in a viewer (e.g. `https://gltf-viewer.donmccurdy.com/`) and confirm which world axis the nose points along natively
2. From that, derive the exact `modelRotationZ` formula for Mapbox's CCW-from-East convention
3. The formula should be a single expression: e.g. `-heading + 90` or `-heading - 90` or `heading + 180`

### 🔴 P0 — Frame-Rate Independent Physics
All physics must be converted to use `dt` (delta time in seconds). Without this, the simulation runs differently on every display refresh rate.

**Recommended approach:**
```js
// Use these conversion factors (pre-computed for Miami Beach lat)
const LAT_DEG_PER_M = 1 / 111111;
const LNG_DEG_PER_M = 1 / (111111 * Math.cos(25.7906 * Math.PI / 180));

// Physics in m/s
const MAX_SPEED_MS = 20;      // ~72 km/h
const ACCEL_MS2    = 7;       // m/s²
const DRAG         = 0.96;    // per normalised frame: speed *= Math.pow(0.96, dt*60)
const TURN_RATE    = 70;      // degrees/sec at full speed

// Position update
const rad = heading * (Math.PI / 180);
lat += Math.cos(rad) * speed * dt * LAT_DEG_PER_M;
lng += Math.sin(rad) * speed * dt * LNG_DEG_PER_M;
```

> **Warning:** The previous dt attempt broke the diagonal movement. Suspect the issue was `lat` and `lng` axes being accidentally swapped during that refactor, NOT the dt approach itself. The formula above has the axes correct.

### 🟡 P1 — Bicycle Kinematic Steering
Replace heading-delta steering with proper bicycle model:
```js
const WHEELBASE = 2.5;  // metres
// steeringAngle updated by A/D keys, clamped to ±35°, auto-centres on release
const steerRad = steeringAngle * (Math.PI / 180);
heading += (speed / WHEELBASE) * Math.tan(steerRad) * dt * (180 / Math.PI);
```
This gives tight turns at low speed and wide arcs at high speed — essential for circuit driving.

### 🟡 P1 — Smooth Input Damping
Once dt physics are solid, re-introduce lerp damping on inputs:
- `ACCEL_DAMP_RATE = 5.0` — throttle ramp
- `STEER_DAMP_RATE = 10.0` — steering wheel lag
- Auto-centre steering on key release

### 🟢 P2 — Circuit Boundaries
After physics are solid, define a Miami Beach loop (Collins Ave corridor) using a GeoJSON `Polygon` and detect when the car exits the boundary.

### 🟢 P2 — Lap Timer
Simple `performance.now()` stopwatch triggered by crossing a start/finish line defined as a GeoJSON `LineString`.

### 🟢 P3 — Swap Vehicle Mesh
Replace the Cesium Milk Truck with a proper low-poly racing car GLB. The mesh should be oriented with its nose along +Y (Mapbox-native forward) to simplify the rotation formula to `modelRotationZ = -heading`.

---

## Key Mapbox GL JS v3 Gotchas (Hard-Won Knowledge)

1. **`addSource` must receive a bare `Feature`, not a `FeatureCollection`**, for model layers to anchor correctly
2. **`addModel` URL must be absolute** (`window.location.origin + '/car.glb'`) — relative paths break silently with Vite
3. **`model-rotation` Z is CCW from East** — not from North, not CW. Always convert heading before applying
4. **`interactive: false`** must be set on the map to prevent user drags from fighting the physics camera
5. **`maxPitch: 85`** must be explicitly set — default cap is 60°, which breaks the 75° chase cam
6. **`map.jumpTo` is synchronous and zero-latency** — safe to call every frame at the end of the render loop
7. **`setConfigProperty('basemap', ...)`** only works after `style.load` fires, not at map init time
8. **`model-scale` paint property** takes a 3-element array `[x, y, z]` in Mapbox-native units — the Milk Truck renders at `[4, 4, 4]` with reasonable proportions relative to buildings

---

## Mapbox Access Token
```
VITE_MAPBOX_TOKEN=pk.…   # lives in .env (git-ignored); template in .env.example
```
This is a valid public Mapbox token. In production it should be scoped (URL restrictions). For prototyping it works as-is.

---

## Recommended First Task for Claude Code

**Fix the mesh orientation definitively, then do the dt physics rewrite.**

Start by:
1. Running `npm run dev` and driving the car to confirm the direction of movement vs. model orientation
2. Adjusting `modelRotationZ` in `buildCarGeoJSON()` until nose = direction of travel
3. Then rewriting the physics loop with `dt`, keeping the axis math (`lng = sin`, `lat = cos`) exactly as it is now
4. Reintroduce the bicycle kinematic model only after the dt physics are confirmed working

The project is very close. The render environment is beautiful, the model loads, and the camera works. The two remaining blockers are mesh orientation and frame-rate independence.
