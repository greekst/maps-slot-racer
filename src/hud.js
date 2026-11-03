import { CAR } from './config.js';
import { formatTime } from './timing.js';
import { speedColor } from './track-layers.js';
import { clamp } from './geo.js';

const $ = id => document.getElementById(id);
const SHIFT_LEDS = 12;

export class Hud {
    constructor(track) {
        this.track = track;
        this.units = 'kmh';
        this.el = {
            lapNum: $('lap-num'), lapTime: $('lap-time'), delta: $('delta'),
            last: $('last-lap'), best: $('best-lap'),
            sectors: [0, 1, 2].map(i => $(`sec-${i}`)),
            speed: $('speed'), unit: $('speed-unit'), gear: $('gear'),
            thr: $('throttle-bar'), brk: $('brake-bar'),
            gripBox: document.querySelector('.grip-box'), gripFill: $('grip-fill'), gripPct: $('grip-pct'),
            shift: $('shift-lights'), message: $('message'), toast: $('toast'), lights: $('lights'),
            advName: $('adv-name'), advArrow: $('adv-arrow'), advDist: $('adv-dist'), advSpeed: $('adv-speed'),
            vignette: $('vignette'), speedlines: $('speedlines'),
        };
        for (let i = 0; i < SHIFT_LEDS; i++) {
            const led = document.createElement('i');
            led.className = i < 5 ? 'g' : i < 9 ? 'y' : 'r';
            this.el.shift.appendChild(led);
        }
        this.leds = [...this.el.shift.children];
        this.initMinimap();
    }

    setUnits(u) {
        this.units = u;
        this.el.unit.textContent = u === 'kmh' ? 'km/h' : 'mph';
    }
    speedIn(v) { return this.units === 'kmh' ? v * 3.6 : v * 2.23694; }
    unitLabel() { return this.units === 'kmh' ? 'km/h' : 'mph'; }

    initMinimap() {
        const c = $('minimap');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const size = 200;
        c.width = c.height = size * dpr;
        this.mm = { c, ctx: c.getContext('2d'), dpr, size };
        const { x, y, n } = this.track;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
            minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]);
        }
        const pad = 16;
        const scale = (size - pad * 2) / Math.max(maxX - minX, maxY - minY);
        const ox = size / 2 - (minX + maxX) / 2 * scale;
        const oy = size / 2 + (minY + maxY) / 2 * scale;
        this.mm.project = (px, py) => [(ox + px * scale) * dpr, (oy - py * scale) * dpr];

        // Pre-render the coloured track
        const bg = document.createElement('canvas');
        bg.width = bg.height = size * dpr;
        const g = bg.getContext('2d');
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 7 * dpr;
        g.beginPath();
        for (let i = 0; i <= n; i += 2) { const [a, b] = this.mm.project(x[i % n], y[i % n]); i ? g.lineTo(a, b) : g.moveTo(a, b); }
        g.closePath(); g.stroke();
        g.lineWidth = 3.5 * dpr;
        for (let i = 0; i < n; i += 4) {
            const j = Math.min(n, i + 5) % n;
            const [a, b] = this.mm.project(x[i], y[i]);
            const [c2, d] = this.mm.project(x[j], y[j]);
            const col = speedColor(this.track.idealSpeed[i]);
            g.strokeStyle = `rgb(${col})`;
            g.beginPath(); g.moveTo(a, b); g.lineTo(c2, d); g.stroke();
        }
        // Start line
        const p = this.track.sample(0);
        const [sx, sy] = this.mm.project(p.x, p.y);
        g.save(); g.translate(sx, sy); g.rotate(p.heading);
        g.fillStyle = '#fff'; g.fillRect(-7 * dpr, -1.5 * dpr, 14 * dpr, 3 * dpr);
        g.restore();
        // Corner labels
        g.font = `600 ${9 * dpr}px Inter, sans-serif`;
        g.fillStyle = 'rgba(255,255,255,0.7)';
        for (const cn of this.track.corners) {
            const q = this.track.sample(cn.apex);
            const [a, b] = this.mm.project(q.x, q.y);
            g.fillText(cn.name, a + 5 * dpr, b - 5 * dpr);
        }
        this.mm.bg = bg;
    }

    drawMinimap(car, ghost) {
        const { ctx, bg, dpr, project } = this.mm;
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.drawImage(bg, 0, 0);
        const dot = (x, y, r, fill, glow) => {
            const [a, b] = project(x, y);
            ctx.beginPath(); ctx.arc(a, b, r * dpr, 0, Math.PI * 2);
            ctx.shadowColor = glow; ctx.shadowBlur = 10 * dpr;
            ctx.fillStyle = fill; ctx.fill();
            ctx.shadowBlur = 0;
        };
        if (ghost) dot(ghost.x, ghost.y, 4, 'rgba(94,231,255,0.9)', '#5ee7ff');
        dot(car.x, car.y, 5.5, '#ffffff', '#ff3b30');
        const [a, b] = project(car.x, car.y);
        ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(a, b, 5.5 * dpr, 0, Math.PI * 2); ctx.stroke();
    }

    update({ car, timer, t, ghost }) {
        const el = this.el;
        el.speed.textContent = Math.round(this.speedIn(car.v));
        el.gear.textContent = car.mode !== 'slot' ? '–' : car.v < 0.3 && car.throttle < 0.05 ? 'N' : car.gear;
        el.thr.style.setProperty('--v', car.throttle.toFixed(3));
        el.brk.style.setProperty('--v', car.brake.toFixed(3));

        const slip = car.slip;
        el.gripFill.style.width = `${clamp(slip / 1.25, 0, 1) * 100}%`;
        el.gripPct.textContent = `${Math.round(slip * 100)}%`;
        el.gripBox.classList.toggle('warn', slip > 0.85 && slip <= 1);
        el.gripBox.classList.toggle('over', slip > 1);

        // Shift lights: fill from 70% → 97% of redline, flash at the top
        const r = (car.rpm - CAR.redlineRpm * 0.7) / (CAR.redlineRpm * 0.27);
        const lit = Math.round(clamp(r, 0, 1) * SHIFT_LEDS);
        this.leds.forEach((led, i) => led.classList.toggle('on', i < lit));
        el.shift.classList.toggle('flash', r >= 1 && Math.floor(t * 12) % 2 === 0);

        // Timing
        el.lapNum.textContent = timer.running ? timer.lap : '–';
        el.lapTime.textContent = formatTime(timer.currentLapTime(t));
        el.last.textContent = formatTime(timer.lastLap);
        el.best.textContent = formatTime(timer.best?.time);
        const d = timer.delta(t, car);
        el.delta.textContent = d == null ? '' : formatTime(d, { sign: true });
        el.delta.className = 'delta mono' + (d == null ? '' : d < 0 ? ' faster' : ' slower');
        el.sectors.forEach((s, i) => {
            s.classList.toggle('active', timer.running && i === timer.sector);
            if (timer.running && i >= timer.sector && !s.dataset.hold) {
                s.querySelector('b').textContent = '–';
                s.classList.remove('purple', 'green', 'yellow');
            }
        });

        // Corner advisory
        const nc = this.track.nextCorner(car.s);
        if (nc) {
            el.advName.textContent = nc.name;
            el.advArrow.textContent = nc.dir === 'L' ? '↰' : '↱';
            el.advDist.textContent = `${Math.round(nc.dist)} m`;
            el.advSpeed.textContent = `${Math.round(this.speedIn(nc.vApex))} ${this.unitLabel()}`;
            const urgent = car.v > nc.vApex * 1.05 && nc.dist < brakingDistance(car.v, nc.vApex) * 1.15;
            el.advSpeed.style.color = urgent ? 'var(--red)' : '';
        }

        // Speed impression
        const sp = clamp((car.v - 30) / 55, 0, 1);
        el.speedlines.style.opacity = (sp * 0.9).toFixed(3);
        el.speedlines.style.transform = `rotate(${(t * 40) % 360}deg) scale(1.6)`;
        el.vignette.style.opacity = (0.45 + sp * 0.45).toFixed(3);

        this.drawMinimap(car, ghost);
    }

    sector(index, time, best) {
        const s = this.el.sectors[index];
        s.querySelector('b').textContent = time.toFixed(2);
        s.classList.remove('purple', 'green', 'yellow');
        s.classList.add(best == null || time < best ? 'purple' : time < best + 0.25 ? 'green' : 'yellow');
        s.dataset.hold = '1';
    }
    clearSectors() {
        for (const s of this.el.sectors) { delete s.dataset.hold; s.querySelector('b').textContent = '–'; s.classList.remove('purple', 'green', 'yellow'); }
    }

    message(text, { sub = '', cls = '', ms = 1400 } = {}) {
        const m = this.el.message;
        m.className = cls;
        m.innerHTML = `${text}${sub ? `<span class="sub">${sub}</span>` : ''}`;
        requestAnimationFrame(() => m.classList.add('show'));
        clearTimeout(this._msgT);
        if (ms) this._msgT = setTimeout(() => m.classList.remove('show'), ms);
    }

    toast(text) {
        const t = this.el.toast;
        t.textContent = text;
        t.classList.add('show');
        clearTimeout(this._toastT);
        this._toastT = setTimeout(() => t.classList.remove('show'), 1600);
    }

    setLights(n) {
        this.el.lights.classList.toggle('hidden', n < 0);
        [...this.el.lights.children].forEach((l, i) => l.classList.toggle('on', i < n));
    }
}

function brakingDistance(v, vTarget) {
    const a = CAR.brakeG * 9.81 * 0.9;
    return Math.max(0, (v * v - vTarget * vTarget) / (2 * a));
}
