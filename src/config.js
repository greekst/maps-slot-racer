// ─── Mapbox ──────────────────────────────────────────────────────────────────
export const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN; // set in .env (see .env.example)

// ─── Car ─────────────────────────────────────────────────────────────────────
// All values SI (kg, W, m, s). Tuned to a ~300 kW rear-drive GT car:
// 0-100 km/h ≈ 4.3 s, top speed ≈ 315 km/h, 1.2 g cornering, 1.25 g braking.
export const CAR = {
    mass: 1300,              // kg
    power: 300_000,          // W at the wheels
    driveGripG: 0.68,        // traction-limited launch accel (g) — rear-drive weight split
    brakeG: 1.25,            // max braking decel (g), ABS-limited
    engineBrakeG: 0.08,      // off-throttle engine braking (g)
    lateralGripG: 1.20,      // cornering limit (g) — exceed it and you de-slot
    cdA: 0.72,               // drag coefficient × frontal area (m²)
    crr: 0.013,              // rolling resistance coefficient
    wheelbase: 2.65,         // m (used for visual front-wheel steer angle)
    // De-slot tolerance: seconds of "1 g over the limit" you can survive.
    // Being 10% over for 0.3 s is fine; 40% over for 0.1 s is not.
    overloadBudget: 0.08,
    // Cosmetic gearbox (sound + HUD): top speed of each gear in km/h
    gears: [62, 98, 138, 178, 218, 262, 320],
    idleRpm: 950,
    redlineRpm: 8600,
};

export const PHYSICS_HZ = 240;
export const G = 9.80665;
export const AIR_DENSITY = 1.225;

// ─── Track ───────────────────────────────────────────────────────────────────
export const TRACK = {
    resampleStep: 1.0,       // m between track samples
    smoothSigma: 10.0,       // m — Gaussian smoothing; sets the effective corner radius
    gridOffset: -12,         // m behind the start line for the standing start
};
