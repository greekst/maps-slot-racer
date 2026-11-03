// Synthesised audio: engine (rpm-tracked), tyre squeal (grip), wind, and one-shots.
// No samples needed; everything is WebAudio oscillators and filtered noise.

import { clamp } from './geo.js';

export class RaceAudio {
    constructor() {
        this.ctx = null;
        this.muted = false;
    }

    // Must be called from a user gesture.
    init() {
        if (this.ctx) { this.ctx.resume(); return; }
        const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = ctx.createGain();
        this.master.gain.value = 0.55;
        const comp = ctx.createDynamicsCompressor();
        this.master.connect(comp).connect(ctx.destination);

        // Engine: two detuned saws + a sub square → soft-clip → low-pass
        this.engineGain = ctx.createGain();
        this.engineGain.gain.value = 0;
        this.engineFilter = ctx.createBiquadFilter();
        this.engineFilter.type = 'lowpass';
        this.engineFilter.Q.value = 4;
        const shaper = ctx.createWaveShaper();
        shaper.curve = softClip(1.8);
        this.oscs = [
            { o: ctx.createOscillator(), type: 'sawtooth', mult: 1, gain: 0.35 },
            { o: ctx.createOscillator(), type: 'sawtooth', mult: 1.007, gain: 0.25 },
            { o: ctx.createOscillator(), type: 'square', mult: 0.5, gain: 0.3 },
            { o: ctx.createOscillator(), type: 'triangle', mult: 2, gain: 0.12 },
        ];
        for (const s of this.oscs) {
            s.o.type = s.type;
            const g = ctx.createGain(); g.gain.value = s.gain;
            s.o.connect(g).connect(shaper);
            s.o.start();
        }
        shaper.connect(this.engineFilter).connect(this.engineGain).connect(this.master);

        const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = noise;
        const noiseSrc = () => { const n = ctx.createBufferSource(); n.buffer = noise; n.loop = true; n.start(); return n; };

        // Tyre squeal: band-passed noise + a wobbling sine
        this.squealGain = ctx.createGain(); this.squealGain.gain.value = 0;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 6;
        noiseSrc().connect(bp).connect(this.squealGain);
        this.squealTone = ctx.createOscillator(); this.squealTone.type = 'sine'; this.squealTone.frequency.value = 1150;
        const toneGain = ctx.createGain(); toneGain.gain.value = 0.25;
        this.squealTone.connect(toneGain).connect(this.squealGain);
        this.squealTone.start();
        this.squealGain.connect(this.master);

        // Wind
        this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
        noiseSrc().connect(lp).connect(this.windGain).connect(this.master);
    }

    setMuted(m) {
        this.muted = m;
        if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }

    update({ rpm, throttle, slip, speed, active }) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const f = rpm / 60 * 3;                 // 6-cyl: 3 firing pulses per revolution
        for (const s of this.oscs) s.o.frequency.setTargetAtTime(f * s.mult, t, 0.015);
        this.engineFilter.frequency.setTargetAtTime(500 + throttle * 2600 + rpm * 0.15, t, 0.03);
        this.engineGain.gain.setTargetAtTime(active ? 0.16 + throttle * 0.16 : 0, t, 0.08);
        const sq = clamp((slip - 0.86) / 0.3, 0, 1) * clamp(speed / 6, 0, 1);
        this.squealGain.gain.setTargetAtTime(sq * 0.22, t, 0.04);
        this.squealTone.frequency.setTargetAtTime(1050 + Math.sin(t * 13) * 60 + sq * 200, t, 0.02);
        this.windGain.gain.setTargetAtTime(clamp(speed / 85, 0, 1) ** 2 * 0.25, t, 0.1);
    }

    shift() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        this.engineGain.gain.cancelScheduledValues(t);
        this.engineGain.gain.setValueAtTime(0.05, t);
        this.engineGain.gain.linearRampToValueAtTime(0.3, t + 0.09);
    }

    beep(freq = 440, dur = 0.18, vol = 0.25) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(this.master); o.start(t); o.stop(t + dur);
    }

    crash() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const n = this.ctx.createBufferSource(); n.buffer = this.noiseBuf;
        const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, t);
        lp.frequency.exponentialRampToValueAtTime(200, t + 0.8);
        const g = this.ctx.createGain(); g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
        n.connect(lp).connect(g).connect(this.master); n.start(t); n.stop(t + 1);
        const o = this.ctx.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.4);
        const og = this.ctx.createGain(); og.gain.setValueAtTime(0.6, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.5);
    }
}

function softClip(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
}
