// Track = a closed centreline ("the slot") built from real road geometry.
//
// Pipeline: lng/lat → local metres → uniform resample → Gaussian smoothing
// (turns sharp intersection vertices into realistic corner radii) → resample
// again → heading + curvature per metre → ideal speed profile.

import { makeProjection, wrapAngle, lerpAngle } from './geo.js';
import { CAR, G, TRACK, AIR_DENSITY } from './config.js';

export class Track {
    constructor(def, opts = {}) {
        const { resampleStep, smoothSigma } = { ...TRACK, ...opts };
        this.name = def.name;
        this.description = def.description;

        const raw = def.coordinates;
        let lng0 = 0, lat0 = 0;
        for (const [lng, lat] of raw) { lng0 += lng; lat0 += lat; }
        lng0 /= raw.length; lat0 /= raw.length;
        this.proj = makeProjection(lng0, lat0);

        let pts = raw.map(([lng, lat]) => this.proj.toXY(lng, lat));
        pts = resampleClosed(pts, resampleStep);
        pts = gaussianClosed(pts, smoothSigma / resampleStep);
        pts = resampleClosed(pts, resampleStep);

        const n = pts.length;
        this.n = n;
        this.x = new Float64Array(n);
        this.y = new Float64Array(n);
        for (let i = 0; i < n; i++) { this.x[i] = pts[i][0]; this.y[i] = pts[i][1]; }
        this.length = polylineLength(pts, true);
        this.ds = this.length / n;

        // Heading (compass rad) via central difference
        this.heading = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
            this.heading[i] = Math.atan2(b[0] - a[0], b[1] - a[1]);
        }
        // Signed curvature (1/m): + = turning right (clockwise), − = left
        const k = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const dh = wrapAngle(this.heading[(i + 1) % n] - this.heading[(i - 1 + n) % n]);
            k[i] = dh / (2 * this.ds);
        }
        this.curvature = gaussian1DClosed(k, 1.5 / this.ds);

        this.buildSpeedProfile();
        this.findCorners();

        // Geographic coords of the processed line (closed ring) for rendering
        this.lngLats = [];
        for (let i = 0; i <= n; i++) this.lngLats.push(this.proj.toLngLat(this.x[i % n], this.y[i % n]));
    }

    // Max speed the car can hold at each sample, then brake- and accel-limited passes.
    buildSpeedProfile() {
        const { n, ds } = this;
        const aLat = CAR.lateralGripG * G;
        const aBrake = CAR.brakeG * G * 0.92; // leave a small margin so the hint is achievable
        const vTop = 90;
        const limit = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const kk = Math.abs(this.curvature[i]);
            limit[i] = Math.min(vTop, Math.sqrt(aLat / Math.max(kk, 1e-6)));
        }
        this.cornerLimit = limit;

        const v = Float64Array.from(limit);
        for (let lap = 0; lap < 2; lap++) {
            for (let i = n - 1; i >= 0; i--) {
                const next = v[(i + 1) % n];
                v[i] = Math.min(v[i], Math.sqrt(next * next + 2 * aBrake * ds));
            }
        }
        for (let lap = 0; lap < 2; lap++) {
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                const a = maxAccel(v[i]);
                v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * Math.max(a, 0) * ds));
            }
        }
        this.idealSpeed = v;
        let t = 0;
        for (let i = 0; i < n; i++) t += ds / Math.max(v[i], 0.5);
        this.idealLapTime = t;
    }

    findCorners() {
        const { n, ds } = this;
        const lim = this.cornerLimit;
        this.corners = [];
        let i = 0;
        // Walk to a straight bit first so we don't split a corner at the wrap
        while (i < n && lim[i] < 60) i++;
        for (let c = 0; c < n; c++) {
            const idx = (i + c) % n;
            if (lim[idx] < 45) {
                let minV = Infinity, minIdx = idx, len = 0, dir = 0;
                let j = idx;
                while (lim[j] < 45 && len < n) {
                    if (lim[j] < minV) { minV = lim[j]; minIdx = j; }
                    dir += this.curvature[j];
                    j = (j + 1) % n; len++;
                }
                // Entry point of the braking zone = first sample where idealSpeed drops
                this.corners.push({
                    s: idx * ds,
                    apex: minIdx * ds,
                    vApex: this.idealSpeed[minIdx],
                    radius: 1 / Math.abs(this.curvature[minIdx]),
                    dir: dir > 0 ? 'R' : 'L',
                });
                c += len;
            }
        }
        this.corners.sort((a, b) => a.s - b.s);
        this.corners.forEach((c, k) => { c.name = `T${k + 1}`; });
    }

    wrap(s) {
        const L = this.length;
        return ((s % L) + L) % L;
    }

    index(s) {
        const u = this.wrap(s) / this.ds;
        const i = Math.floor(u);
        return [i % this.n, (i + 1) % this.n, u - i];
    }

    // Fills `out` with {x, y, heading, curvature} at distance s along the track.
    sample(s, out = {}) {
        const [i, j, f] = this.index(s);
        out.x = this.x[i] + (this.x[j] - this.x[i]) * f;
        out.y = this.y[i] + (this.y[j] - this.y[i]) * f;
        out.heading = lerpAngle(this.heading[i], this.heading[j], f);
        out.curvature = this.curvature[i] + (this.curvature[j] - this.curvature[i]) * f;
        return out;
    }

    lerpArray(arr, s) {
        const [i, j, f] = this.index(s);
        return arr[i] + (arr[j] - arr[i]) * f;
    }

    nextCorner(s) {
        const sw = this.wrap(s);
        for (const c of this.corners) if (c.apex > sw) return { ...c, dist: c.apex - sw };
        const c = this.corners[0];
        return c ? { ...c, dist: c.apex + this.length - sw } : null;
    }
}

// Longitudinal acceleration available at speed v with full throttle (used for the ideal profile).
export function maxAccel(v) {
    const m = CAR.mass;
    const drive = Math.min(CAR.driveGripG * G * m, CAR.power / Math.max(v, 1));
    const drag = 0.5 * AIR_DENSITY * CAR.cdA * v * v + CAR.crr * m * G;
    return (drive - drag) / m;
}

function polylineLength(pts, closed) {
    let L = 0;
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        L += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return L;
}

function resampleClosed(pts, step) {
    const n = pts.length;
    const L = polylineLength(pts, true);
    const count = Math.max(8, Math.round(L / step));
    const spacing = L / count;
    const out = [];
    let seg = 0, segStart = 0;
    let a = pts[0], b = pts[1 % n];
    let segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let k = 0; k < count; k++) {
        const target = k * spacing;
        while (segStart + segLen < target && seg < n - 1) {
            segStart += segLen;
            seg++;
            a = pts[seg]; b = pts[(seg + 1) % n];
            segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const f = segLen > 0 ? (target - segStart) / segLen : 0;
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    return out;
}

function gaussianKernel(sigma) {
    const r = Math.ceil(sigma * 3);
    const w = [];
    let sum = 0;
    for (let k = -r; k <= r; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); sum += v; }
    return { r, w: w.map(v => v / sum) };
}

function gaussianClosed(pts, sigma) {
    if (sigma <= 0) return pts;
    const { r, w } = gaussianKernel(sigma);
    const n = pts.length;
    return pts.map((_, i) => {
        let x = 0, y = 0;
        for (let k = -r; k <= r; k++) {
            const p = pts[((i + k) % n + n) % n];
            x += p[0] * w[k + r]; y += p[1] * w[k + r];
        }
        return [x, y];
    });
}

function gaussian1DClosed(arr, sigma) {
    const { r, w } = gaussianKernel(sigma);
    const n = arr.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let v = 0;
        for (let k = -r; k <= r; k++) v += arr[((i + k) % n + n) % n] * w[k + r];
        out[i] = v;
    }
    return out;
}
