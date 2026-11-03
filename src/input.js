// Keyboard / gamepad / touch → analog throttle and brake (0..1).
// Keyboard is ramped so tapping feels like feathering a slot-car trigger.

import { damp } from './geo.js';

const THROTTLE_KEYS = new Set(['KeyW', 'ArrowUp']);
const BRAKE_KEYS = new Set(['KeyS', 'ArrowDown']);

export class Input {
    constructor() {
        this.down = new Set();
        this.throttle = 0;
        this.brake = 0;
        this.touchThrottle = false;
        this.touchBrake = false;
        this.handlers = {};
        this.source = 'keyboard';
        this.prevButtons = [];

        window.addEventListener('keydown', e => {
            if (THROTTLE_KEYS.has(e.code) || BRAKE_KEYS.has(e.code) || e.code === 'Space') e.preventDefault();
            if (!e.repeat) this.emit('key', e.code);
            this.down.add(e.code);
            this.source = 'keyboard';
        });
        window.addEventListener('keyup', e => this.down.delete(e.code));
        window.addEventListener('blur', () => { this.down.clear(); this.emit('blur'); });

        const touchZone = e => {
            if (e.pointerType === 'mouse') return;
            const t = e.target.closest?.('[data-touch]');
            if (!t) return;
            const on = e.type === 'pointerdown';
            if (t.dataset.touch === 'throttle') this.touchThrottle = on;
            if (t.dataset.touch === 'brake') this.touchBrake = on;
            this.source = 'touch';
        };
        window.addEventListener('pointerdown', touchZone);
        window.addEventListener('pointerup', touchZone);
        window.addEventListener('pointercancel', touchZone);
    }

    on(name, fn) { this.handlers[name] = fn; }
    emit(name, arg) { this.handlers[name]?.(arg); }

    update(dt) {
        let thr = [...THROTTLE_KEYS].some(k => this.down.has(k)) || this.touchThrottle ? 1 : 0;
        let brk = [...BRAKE_KEYS].some(k => this.down.has(k)) || this.touchBrake ? 1 : 0;
        this.throttle += (thr - this.throttle) * damp(thr > this.throttle ? 18 : 28, dt);
        this.brake += (brk - this.brake) * damp(brk > this.brake ? 22 : 30, dt);

        // Gamepad triggers override when pressed: RT = throttle, LT = brake (true analog)
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const pad of pads) {
            if (!pad) continue;
            const rt = pad.buttons[7]?.value ?? 0;
            const lt = pad.buttons[6]?.value ?? 0;
            if (rt > 0.02 || lt > 0.02) {
                this.throttle = rt; this.brake = lt;
                this.source = 'gamepad';
            }
            // Edge-triggered buttons: A=start, Y=camera, Start=pause, B=reset, X=ghost
            const map = { 0: 'Space', 3: 'KeyC', 9: 'Escape', 1: 'KeyR', 2: 'KeyG' };
            for (const [idx, code] of Object.entries(map)) {
                const pressed = !!pad.buttons[idx]?.pressed;
                const key = `${pad.index}:${idx}`;
                if (pressed && !this.prevButtons[key]) this.emit('key', code);
                this.prevButtons[key] = pressed;
            }
            break;
        }
        if (this.throttle < 0.001) this.throttle = 0;
        if (this.brake < 0.001) this.brake = 0;
        return { throttle: this.throttle, brake: this.brake };
    }
}
