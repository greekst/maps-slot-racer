# Slot Racer — v1.1

Real-world slot-car racing on real streets. The car rides a "slot" along a closed loop of actual Miami Beach roads (Mapbox GL JS v3, Standard style). There's no steering: you control throttle and brake, and if you carry too much speed into a corner you de-slot and fly off.

This version is a clean rebuild of the v1 prototype (kept in `legacy/`). Treating the car as a slot car first lets us get perspective, routes, scale and speed physics right before adding free steering.

## Run

```bash
cp .env.example .env   # then paste your Mapbox public token into .env
npm install
npm run dev          # http://localhost:5173
```

If you use nvm and `npm` isn't on PATH, run `nvm use 24` first.

| Key | Action |
|---|---|
| W / ↑ | Throttle (ramped, so taps feather it) |
| S / ↓ | Brake |
| C | Camera: Chase, Low Chase, Helicopter, Bonnet (driver's eye), Bumper |
| R | Restart from the grid |
| G | Ghost of your best lap on/off |
| H | Speed-coloured racing band on/off |
| L | Time of day: dusk, night, dawn, day |
| Q | Graphics quality: high (4K shadows, palms and parked cars), medium (2K shadows), low (no shadows or props) |
| U | km/h or mph |
| M | Mute |
| Esc / P | Pause |

On a gamepad, RT is throttle and LT is brake (both analog), A starts, Y switches camera, B restarts and Start pauses. On touch screens, the right side of the screen is throttle and the left side is brake.

## The circuit

**South Beach Circuit** is 4.32 km: Collins Ave north, then 17th St west, Washington Ave south and 5th St east, all left-handers. The loop follows one-way streets in the legal direction. The route came from the Mapbox Directions API and is stored in `src/tracks/south-beach.json`, so no API calls happen at runtime.

To add a track, drop another `{ name, description, coordinates: [[lng,lat],…] }` file next to it. The coordinates must form a closed loop, and you don't need to repeat the first point.

## How it works

```
index.html            HUD markup
src/main.js           state machine (title → countdown → race ⇄ paused), main loop, key bindings
src/config.js         Mapbox token, car specs (SI units), physics rate, track smoothing
src/track.js          lng/lat → metres, resample, Gaussian smoothing, heading and curvature, ideal speed profile
src/car.js            SlotCar physics: slot mode, off-track free body, marshal recovery, cosmetic gearbox
src/camera.js         chase camera via Mapbox FreeCamera API, speed-sensitive FOV, shake, crash cam
src/three-layer.js    Mapbox custom layer that renders the car, ghost and city with Three.js (lights, shadows, fog)
src/sky-env.js        procedural sky per light preset, used for reflections
src/city/             street-level city built from Mapbox Streets vector tiles (see below)
src/car-model.js      procedural GT car in real metres (+Y = nose, +Z = up)
src/track-layers.js   slot, rails, speed-coloured band and chequered line as Mapbox layers
src/timing.js         laps, 3 sectors, live delta, ghost recording (best lap is stored in localStorage)
src/hud.js            timing tower, cluster, shift lights, grip meter, minimap, corner advisory
src/audio.js          synthesised engine, tyre squeal, wind, beeps and crash sounds (WebAudio, no assets)
tools/                headless checks (see below)
```

### Physics
- **Units and timestep:** everything is SI and uses a fixed **240 Hz** timestep, so behaviour doesn't change with frame rate. Speed shown on the HUD is real speed.
- **Longitudinal:** power-limited drive (300 kW), a traction limit at launch, 1.25 g ABS braking, aero drag (CdA 0.72), rolling resistance and engine braking. The result is 0–100 km/h in 4.3 s and a theoretical top speed of about 315 km/h.
- **Lateral:** the demand is `a = v²·κ`, compared against a 1.2 g grip limit. Going over the limit builds "overload" and scrubs speed. You can run about 5% over the limit briefly; at about 8% over you de-slot. The HUD grip meter shows this demand live.
- **Corner radii:** these come from Gaussian smoothing of the road centreline (`TRACK.smoothSigma`). The corners work out to 8–15 m radius, with apex speeds of 35–48 km/h.

### Rendering choices that fixed v1's problems
- **Car orientation:** the car is built procedurally with a known axis convention, so `yaw = −heading`. There's no mystery mesh orientation any more.
- **No car/camera desync:** the car is drawn in a Three.js custom layer that reads the pose at draw time, not from a GeoJSON `setData`, which is processed asynchronously. The scene is re-anchored at the car every frame, which keeps float precision tight.
- **Handedness:** Mapbox's projection matrix already mirrors handedness because mercator y points south. The y-flip therefore has to live in the projection, never in the scene graph. Otherwise Three culls the wrong faces and you see the inside of the car.
- **Camera floor:** Mapbox floors the camera altitude at maxZoom's height (about 5 m at z24). `map.transform._maxZoom` is raised so a chase cam can sit at 1.2–2.6 m.
- **FOV:** there's no public API for FOV, so `map.transform.fov` is set directly. It widens with speed.
- **Depth range:** Mapbox gives 3D custom layers a compressed depth range. Three's shadow pass needs the full range, so `render()` switches to `[0, 1]` and a hook object restores Mapbox's range before the colour pass.
- **GL state hand-back:** after Three renders we reset the viewport and the `UNPACK_FLIP_Y` / `PREMULTIPLY_ALPHA` flags. Without that reset, Mapbox's colour-grading LUT upload fails.

### The city (src/city)
Mapbox's HD roads and 3D facades don't cover Miami Beach (those tiles return 404), and Standard's own buildings are plain blocks. So at startup the game fetches the Mapbox Streets v8 tiles around the circuit (z16, about 35 tiles, with your token) and builds the street itself. Nothing from the tiles is stored in the repo.

- `data.js` decodes buildings, roads, sidewalks, crossings, traffic signals, bus stops and POIs, clipped to exact tile bounds, into track metres.
- `buildings.js` turns about 3,100 footprints into one Three.js mesh. Standard's 3D buildings are switched off. A facade shader fits window bays to each wall and picks a style per building: pastel Art Deco low-rise, glass towers with balcony slabs, parking decks, or houses. Buildings near the circuit get storefronts, and windows light up at dusk and night.
- `roads.js` draws asphalt, curbs, sidewalks, double-yellow centre lines, dashed lane lines, edge lines and zebra crosswalks as Mapbox line layers, trimmed back from intersections. Lane counts come from road class, because the data has none.
- `props.js` plants swaying palms along the sidewalks and parks about 1,000 cars (sedans, hatchbacks, SUVs) at the kerbs, clear of junctions and crossings. Instances are split into 150 m chunks so off-screen ones are culled.
- `furniture.js` adds instanced street lights (with glows and light pools at night) and mast-arm traffic signals at the real signal locations.

Shadows come from the Mapbox Standard sun direction for each preset and fall on a shadow-catcher plane over Mapbox's ground. Fog uses true eye distance, so distant buildings fade with the map.

## Tools

```bash
node tools/track-report.mjs [sigma]   # length, corners (radius, apex speed), ideal lap
node tools/sim.mjs [aggression]       # bot drives the ideal profile ×aggression → lap times, 0-100, de-slots
node tools/smoke.mjs                  # browser smoke test (npm run smoke), see below
node tools/shots.mjs out --modes=0,2 --light=day,dusk   # screenshots at fixed spots on the circuit
```

At 1.0 the bot laps in 1:25.8, which matches the theoretical ideal. At 1.05 it laps in about 1:24.5 and stays on the track. At 1.08 it de-slots at every hairpin.

In the browser console, `__slot` exposes `{ map, track, car, timer, camera, carLayer }`. Call `__slot.advance(seconds)` to step the game without requestAnimationFrame, which is useful when testing in a hidden tab.

`tools/smoke.mjs` starts the Vite dev server, opens the game in headless Chromium (Playwright, not a project dependency: it must be resolvable from Node, e.g. on `NODE_PATH`) and checks that:
- the Mapbox style and tiles load, and no Mapbox request fails;
- the same bot as `sim.mjs` completes two laps via `__slot.advance()` with no de-slots, and the flying lap is within ±1.5 s of 1:25.8 (`SMOKE_EXPECT`, `SMOKE_TOL` override this);
- there are no console errors or uncaught exceptions.

It needs `VITE_MAPBOX_TOKEN` in the environment or `.env`, and exits non-zero on any failure. Set `SMOKE_SCREENSHOT=out.png` to save the final frame, and `CHROMIUM_PATH` to use a specific browser binary.

## Next steps
1. **Feel pass on real hardware.** Tune `overloadBudget`, the keyboard ramp and the camera numbers after driving it at 60/120 Hz.
2. **Better racing lines at intersections.** Replace Gaussian smoothing with fitted corner arcs so each corner's radius can be authored individually.
3. **AI opponents in other slots.** Offset lanes of the same centreline would work, just like a real multi-lane slot track.
4. **More circuits**, plus a track picker on the title screen.
5. **Free steering (v2).** Replace the 1-D slot state with a 2-D bicycle model. The rendering, camera and timing layers already work in 2-D world space.
