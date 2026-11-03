// Chase camera driven through Mapbox's FreeCamera API.
// Everything is computed in local track metres, then converted to lng/lat once.

import mapboxgl from 'mapbox-gl';
import { damp, lerpAngle, clamp } from './geo.js';

// `frame` = how far below screen centre the car sits, in degrees of the (≈37° vertical) FOV.
// `dist` is to the car's centre (the rear bumper is 2.3 m closer).
// `fov`/`fovBoost` = vertical FOV at rest and extra degrees at ~300 km/h.
const MODES = [
    { name: 'Chase',      dist: 8.6, height: 2.6, frame: 9.0, fov: 50, fovBoost: 14, pullPerMs: 0.035, dropPerMs: 0.005 },
    { name: 'Low Chase',  dist: 6.6, height: 1.25, frame: 6.0, fov: 54, fovBoost: 16, pullPerMs: 0.02, dropPerMs: 0.002 },
    { name: 'Helicopter', dist: 34,  height: 30,  frame: 4.0, fov: 40, fovBoost: 4, pullPerMs: 0.25, dropPerMs: 0 },
];

export class ChaseCamera {
    constructor(map, track) {
        this.map = map;
        this.track = track;
        this.modeIndex = 0;
        this.heading = 0;
        this.x = 0; this.y = 0; this.z = 3;
        this.dist = MODES[0].dist;
        this.orbit = 0;
        this.shake = 0;
        this.initialised = false;
    }

    get mode() { return MODES[this.modeIndex]; }

    cycle() {
        this.modeIndex = (this.modeIndex + 1) % MODES.length;
        return this.mode.name;
    }

    snap() { this.initialised = false; }

    // car: SlotCar. attract = slow orbit for the title screen.
    update(dt, car, { attract = false } = {}) {
        const m = this.mode;
        const trackHeading = car.mode === 'slot' ? car.heading - car.drift : this.heading;

        if (!this.initialised) {
            this.heading = trackHeading;
            this.dist = m.dist;
            this.initialised = true;
        }

        let heading, dist, height, frameDeg, fov;
        if (attract) {
            this.orbit += dt * 0.12;
            heading = trackHeading + Math.PI * 0.85 + Math.sin(this.orbit) * 0.9;
            dist = 9.5; height = 2.6; frameDeg = 2; fov = 45;
            this.heading = lerpAngle(this.heading, heading, damp(3, dt));
        } else {
            // Follow the direction of travel with a little lag so corners read on screen
            const rate = car.mode === 'slot' ? 4.5 : 1.2;
            this.heading = lerpAngle(this.heading, trackHeading, damp(rate, dt));
            const v = car.v;
            const targetDist = m.dist + v * m.pullPerMs;
            this.dist += (targetDist - this.dist) * damp(3, dt);
            dist = this.dist;
            height = Math.max(0.9, m.height - v * m.dropPerMs);
            frameDeg = m.frame;
            fov = m.fov + m.fovBoost * clamp(v / 85, 0, 1) ** 1.5;
        }
        this.fov = this.fov == null ? fov : this.fov + (fov - this.fov) * damp(4, dt);
        // Mapbox has no public FOV API; the transform setter is stable across v3.
        if (this.map.transform && Math.abs(this.map.transform.fov - this.fov) > 0.01) this.map.transform.fov = this.fov;

        const h = this.heading;
        const fx = Math.sin(h), fy = Math.cos(h);

        // Shake: kerb-rumble when near the grip limit, and a hit when de-slotting
        const slipShake = clamp((car.slip - 0.85) / 0.4, 0, 1) * 0.05 + clamp(car.v / 90, 0, 1) * 0.012;
        this.shake = Math.max(this.shake * Math.exp(-3 * dt), slipShake);
        const t = performance.now() / 1000;
        const sx = (Math.sin(t * 37) + Math.sin(t * 23.3)) * this.shake;
        const sz = (Math.sin(t * 41.7) + Math.sin(t * 29.1)) * this.shake * 0.6;

        if (car.mode === 'slot' || attract) {
            this.x = car.x - fx * dist + fy * sx;
            this.y = car.y - fy * dist - fx * sx;
            this.z = height + sz + (car.z || 0) * 0.5;
        } else {
            // Crash cam: stop following, drift up a little and watch the wreck
            this.z += (height + 2.5 - this.z) * damp(1.5, dt);
            this.x += fy * sx; this.y -= fx * sx;
        }

        // Aim so the car's body (≈0.6 m up) sits `frameDeg` below screen centre
        const horiz = Math.max(0.5, Math.hypot(car.x - this.x, car.y - this.y));
        const carDown = Math.atan2(this.z - 0.6 - (car.z || 0), horiz) * 180 / Math.PI;
        const pitch = clamp(90 - carDown + frameDeg, 0, 85);
        const bearing = Math.atan2(car.x - this.x, car.y - this.y) * 180 / Math.PI;

        const [lng, lat] = this.track.proj.toLngLat(this.x, this.y);
        const opts = this.map.getFreeCameraOptions();
        opts.position = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], this.z);
        opts.setPitchBearing(pitch, bearing);
        this.map.setFreeCameraOptions(opts);
    }

    kick(amount) { this.shake = Math.max(this.shake, amount); }
}
