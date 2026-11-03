// Local tangent-plane projection around an origin.
// x = metres East, y = metres North. Accurate to well under 1 cm over a few km.
//
// Heading convention used everywhere in this project:
//   compass radians, 0 = North, +π/2 = East (clockwise), same as Mapbox bearing.
//   direction vector = (sin h, cos h)

export function makeProjection(lng0, lat0) {
    const phi = lat0 * Math.PI / 180;
    const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
    const mPerDegLng = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
    return {
        lng0, lat0,
        toXY: (lng, lat) => [(lng - lng0) * mPerDegLng, (lat - lat0) * mPerDegLat],
        toLngLat: (x, y) => [lng0 + x / mPerDegLng, lat0 + y / mPerDegLat],
    };
}

export const DEG = Math.PI / 180;

export function wrapAngle(a) {
    a = (a + Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a - Math.PI;
}

export function lerpAngle(a, b, t) {
    return a + wrapAngle(b - a) * t;
}

// Frame-rate independent exponential smoothing factor.
export function damp(rate, dt) {
    return 1 - Math.exp(-rate * dt);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
