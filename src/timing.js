// Lap timing, 3 sectors, live delta to best, and ghost recording/playback.
// Best lap + ghost persist per track in localStorage (best-effort; works without it).

const SAMPLE_DT = 1 / 30;

export class LapTimer {
    constructor(track, storageKey) {
        this.track = track;
        this.key = storageKey;
        this.best = null;             // { time, sectors: [..], samples: [[t, s, x, y, heading], ...] }
        this.load();
        this.reset();
    }

    reset() {
        this.running = false;
        this.lap = 0;
        this.lapStart = 0;
        this.lastLap = null;
        this.sectorTimes = [];
        this.sector = 0;
        this.samples = [];
        this.nextSample = 0;
        this.deslotsThisLap = 0;
        this.events = [];
    }

    start(t) {
        this.running = true;
        this.lap = 1;
        this.lapStart = t;
        this.sector = 0;
        this.sectorStart = t;
        this.sectorTimes = [];
        this.samples = [];
        this.nextSample = t;
    }

    // Distance into the current lap. Lap k spans car.s ∈ [(k-1)·L, k·L); lap 1 includes the grid run-up.
    lapDistance(car) {
        return car.s - (this.lap - 1) * this.track.length;
    }

    update(t, car) {
        if (!this.running) return;
        const L = this.track.length;
        const d = this.lapDistance(car);

        if (t >= this.nextSample) {
            this.samples.push([t - this.lapStart, Math.max(0, d), car.x, car.y, car.heading]);
            this.nextSample += SAMPLE_DT;
        }

        const sectorIdx = Math.min(2, Math.max(0, Math.floor((d / L) * 3)));
        if (sectorIdx > this.sector) {
            const st = t - this.sectorStart;
            this.sectorTimes[this.sector] = st;
            this.events.push({ type: 'sector', index: this.sector, time: st, best: this.best?.sectors?.[this.sector] });
            this.sector = sectorIdx;
            this.sectorStart = t;
        }

        if (d >= L) {
            const lapTime = t - this.lapStart;
            this.sectorTimes[2] = t - this.sectorStart;
            const isBest = !this.best || lapTime < this.best.time;
            const prevBest = this.best?.time ?? null;
            if (isBest) {
                this.best = { time: lapTime, sectors: [...this.sectorTimes], samples: this.samples };
                this.save();
            }
            this.lastLap = lapTime;
            this.events.push({ type: 'lap', lap: this.lap, time: lapTime, isBest, prevBest, deslots: this.deslotsThisLap });
            this.lap++;
            this.lapStart = t;
            this.sector = 0;
            this.sectorStart = t;
            this.sectorTimes = [];
            this.samples = [];
            this.nextSample = t;
            this.deslotsThisLap = 0;
        }
    }

    currentLapTime(t) { return this.running ? t - this.lapStart : 0; }

    // Live delta vs best lap at the same distance (negative = faster).
    delta(t, car) {
        if (!this.running || !this.best || this.lap === 1) return null;
        const d = this.lapDistance(car);
        const S = this.best.samples;
        if (S.length < 2) return null;
        let lo = 0, hi = S.length - 1;
        if (d <= S[0][1]) return null;
        if (d >= S[hi][1]) return (t - this.lapStart) - this.best.time;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid][1] < d) lo = mid; else hi = mid; }
        const a = S[lo], b = S[hi];
        const f = b[1] > a[1] ? (d - a[1]) / (b[1] - a[1]) : 0;
        const bestT = a[0] + (b[0] - a[0]) * f;
        return (t - this.lapStart) - bestT;
    }

    // Ghost pose at the current lap time.
    ghost(t) {
        if (!this.running || !this.best || this.lap < 2) return null;
        const S = this.best.samples;
        const lt = t - this.lapStart;
        if (lt < 0 || lt > this.best.time || S.length < 2) return null;
        const i = Math.max(0, Math.min(S.length - 2, Math.floor(lt / SAMPLE_DT)));
        const a = S[i], b = S[i + 1];
        const f = Math.min(1, Math.max(0, (lt - a[0]) / (b[0] - a[0] || 1)));
        let dh = b[4] - a[4];
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        const speed = Math.hypot(b[2] - a[2], b[3] - a[3]) / SAMPLE_DT;
        return {
            x: a[2] + (b[2] - a[2]) * f,
            y: a[3] + (b[3] - a[3]) * f,
            heading: a[4] + dh * f,
            wheelAngle: lt * speed / 0.34,
        };
    }

    load() {
        try {
            const raw = localStorage.getItem(this.key);
            if (raw) this.best = JSON.parse(raw);
        } catch { /* storage unavailable */ }
    }

    save() {
        try { localStorage.setItem(this.key, JSON.stringify(this.best)); } catch { /* ignore */ }
    }

    clearBest() {
        this.best = null;
        try { localStorage.removeItem(this.key); } catch { /* ignore */ }
    }
}

export function formatTime(t, { sign = false } = {}) {
    if (t == null || !isFinite(t)) return '–:––.–––';
    const neg = t < 0;
    const a = Math.abs(t);
    const m = Math.floor(a / 60);
    const s = a - m * 60;
    const body = m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
    return sign ? `${neg ? '−' : '+'}${body}` : body;
}
