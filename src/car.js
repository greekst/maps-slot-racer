// Slot-car physics.
//
// While "in the slot" the car is 1-D: state is (s, v) along the track centreline.
// Longitudinal: power-limited drive, traction limit, ABS brakes, aero drag,
// rolling resistance, engine braking. Lateral: a = v²·κ against a grip limit.
// Exceed the limit for too long → the car de-slots and flies off on a free-body
// 2-D slide, then gets marshalled back onto the track (like a real slot car).

import { CAR, G, AIR_DENSITY, TRACK } from './config.js';
import { clamp, damp, wrapAngle } from './geo.js';

const DEG = Math.PI / 180;

export class SlotCar {
    constructor(track) {
        this.track = track;
        this.events = [];
        this.reset(TRACK.gridOffset);
    }

    reset(s) {
        this.mode = 'slot';          // 'slot' | 'off' | 'recover'
        this.s = s;                  // distance along track (unwrapped; can be negative on the grid)
        this.v = 0;                  // m/s along the track
        this.throttle = 0;
        this.brake = 0;
        this.slip = 0;               // lateral demand / grip (1.0 = at the limit)
        this.overload = 0;           // accumulated over-limit "g-seconds"
        this.latG = 0;               // smoothed, signed (+ = pushed left, i.e. right-hand turn)
        this.longG = 0;              // smoothed, + = accelerating
        this.drift = 0;              // visual yaw offset from the slot (rad)
        this.steer = 0;              // visual front-wheel angle (rad)
        this.roll = 0;
        this.pitch = 0;
        this.z = 0;
        this.opacity = 1;
        this.wheelAngle = 0;
        this.gear = 1;
        this.rpm = CAR.idleRpm;
        this.off = null;
        this.syncPoseToTrack();
    }

    syncPoseToTrack() {
        const p = this.track.sample(this.s);
        this.x = p.x; this.y = p.y;
        this.heading = p.heading + this.drift;
        this.curvature = p.curvature;
        return p;
    }

    // input: { throttle 0..1, brake 0..1 }. `live` = false before lights-out (car held on the grid).
    step(dt, input, live) {
        this.throttle = input.throttle;
        this.brake = input.brake;
        if (this.mode === 'slot') this.stepSlot(dt, live);
        else if (this.mode === 'off') this.stepOff(dt);
        else this.stepRecover(dt);
        this.stepDrivetrain(dt, live);
    }

    stepSlot(dt, live) {
        const m = CAR.mass;
        const v = this.v;
        let a = 0;
        if (live) {
            const drive = this.throttle * Math.min(CAR.driveGripG * G * m, CAR.power / Math.max(v, 1));
            const brake = this.brake * CAR.brakeG * G * m;
            const drag = 0.5 * AIR_DENSITY * CAR.cdA * v * v
                + CAR.crr * m * G
                + (this.throttle < 0.05 ? CAR.engineBrakeG * G * m * Math.min(1, v / 5) : 0);
            a = (drive - (v > 0 ? brake + drag : 0)) / m;
        }
        this.v = Math.max(0, v + a * dt);
        this.s += this.v * dt;

        const p = this.track.sample(this.s);
        const k = p.curvature;
        const aLat = this.v * this.v * k;                    // signed
        const grip = CAR.lateralGripG * G;
        this.slip = Math.abs(aLat) / grip;

        if (this.slip > 1) {
            this.overload += (this.slip - 1) * dt;
            // Tyres scrubbing sideways bleed speed
            this.v = Math.max(0, this.v - (this.slip - 1) * G * 1.5 * dt);
        } else {
            this.overload = Math.max(0, this.overload - dt * 0.2);
        }

        // Visual: tail steps out as you approach and pass the limit
        const driftTarget = Math.sign(k) * clamp((this.slip - 0.82) / 0.3, 0, 1) * 16 * DEG;
        this.drift += (driftTarget - this.drift) * damp(10, dt);
        this.steer = Math.atan(CAR.wheelbase * k) - this.drift * 0.6;

        this.longG += (a / G - this.longG) * damp(8, dt);
        this.latG += (aLat / G - this.latG) * damp(8, dt);
        this.roll = clamp(this.latG * 2.2, -4, 4) * DEG;
        this.pitch = clamp(-this.longG * 1.4, -3, 3) * DEG;

        this.x = p.x; this.y = p.y;
        this.heading = p.heading + this.drift;
        this.curvature = k;
        this.wheelAngle += this.v * dt / 0.34;

        if (this.overload > CAR.overloadBudget) this.deslot(p, k);
    }

    deslot(p, k) {
        const h = p.heading;
        const fwd = [Math.sin(h), Math.cos(h)];
        const right = [Math.cos(h), -Math.sin(h)];
        const outward = -Math.sign(k) || 1;              // right-hand turn → fly out to the left
        const kick = this.v * 0.28;
        const turnSign = Math.sign(k) || 1;
        this.off = {
            t: 0,
            s: this.s,
            vx: fwd[0] * this.v + right[0] * outward * kick,
            vy: fwd[1] * this.v + right[1] * outward * kick,
            vz: Math.min(6, this.v * 0.12),
            yawRate: turnSign * (2.5 + this.v * 0.18),
            rollRate: this.v > 22 ? outward * (4 + this.v * 0.1) : 0,
            speed: this.v,
        };
        this.mode = 'off';
        this.events.push({ type: 'deslot', speed: this.v, s: this.s });
    }

    stepOff(dt) {
        const o = this.off;
        o.t += dt;
        const sp = Math.hypot(o.vx, o.vy);
        if (sp > 0.01) {
            // Tumbling/sliding sideways sheds speed fast: ~1.4 g friction plus quadratic scrub
            const dec = Math.min(sp, (1.4 * G + 0.02 * sp * sp) * dt);
            o.vx -= (o.vx / sp) * dec;
            o.vy -= (o.vy / sp) * dec;
        }
        this.x += o.vx * dt;
        this.y += o.vy * dt;
        o.vz -= G * dt;
        this.z += o.vz * dt;
        if (this.z < 0) { this.z = 0; o.vz = -o.vz * 0.35; o.rollRate *= 0.6; }
        this.heading = wrapAngle(this.heading + o.yawRate * dt);
        o.yawRate *= Math.exp(-1.6 * dt);
        this.roll += o.rollRate * dt;
        o.rollRate *= Math.exp(-0.8 * dt);
        this.v = Math.hypot(o.vx, o.vy);
        this.wheelAngle += this.v * dt / 0.34;
        this.slip = 0;
        this.latG *= Math.exp(-4 * dt);
        this.longG *= Math.exp(-4 * dt);

        if ((o.t > 1.3 && sp < 1) || o.t > 2.2) {
            this.mode = 'recover';
            o.recoverT = 0;
        }
    }

    stepRecover(dt) {
        const o = this.off;
        o.recoverT += dt;
        const FADE = 0.35;
        if (o.recoverT < FADE) {
            this.opacity = 1 - o.recoverT / FADE;
        } else if (!o.placed) {
            o.placed = true;
            const s = o.s - 3;
            this.s = s; this.v = 0; this.z = 0; this.roll = 0; this.pitch = 0;
            this.drift = 0; this.overload = 0; this.slip = 0;
            this.syncPoseToTrack();
        } else {
            this.opacity = Math.min(1, (o.recoverT - FADE) / FADE);
            if (this.opacity >= 1) {
                this.mode = 'slot';
                this.off = null;
                this.events.push({ type: 'recovered' });
            }
        }
    }

    // Cosmetic sequential gearbox → gear + rpm for the HUD and engine sound.
    stepDrivetrain(dt, live) {
        const kmh = this.v * 3.6;
        const gears = CAR.gears;
        let target;
        if (!live || this.mode !== 'slot') {
            target = CAR.idleRpm + this.throttle * (CAR.redlineRpm * 0.82 - CAR.idleRpm);
        } else {
            if (kmh > gears[this.gear - 1] * 0.96 && this.gear < gears.length) {
                this.gear++;
                this.events.push({ type: 'shift', dir: 1 });
            } else if (this.gear > 1 && kmh < gears[this.gear - 2] * 0.72) {
                this.gear--;
                this.events.push({ type: 'shift', dir: -1 });
            }
            target = Math.max(CAR.idleRpm + 600 * this.throttle, CAR.redlineRpm * kmh / gears[this.gear - 1]);
        }
        if (this.mode !== 'slot') this.gear = 1;
        this.rpm += (target - this.rpm) * damp(this.mode === 'slot' && live ? 25 : 6, dt);
    }
}
