// Visual regression helper: renders the game at fixed spots on the circuit and saves PNGs.
// node tools/shots.mjs [outDir] [--modes=0,1] [--light=dusk,day] [--w=1600 --h=900]
//
// Each shot: car placed at distance s (m) at the bot's ideal speed, camera settled,
// tiles loaded, then a screenshot. Use it to compare graphics changes side by side.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)]; }));
const outDir = process.argv.slice(2).find(a => !a.startsWith('--')) || 'shots';
const modes = (args.modes ?? '0').split(',').map(Number);
const lights = (args.light ?? 'dusk').split(',');
const W = +(args.w ?? 1600), H = +(args.h ?? 900);
const SPOTS = (args.spots ?? '300,960,1500,2600,3180,3900').split(',').map(Number);

fs.mkdirSync(outDir, { recursive: true });
const root = new URL('..', import.meta.url).pathname;
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } });
await server.listen();
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    proxy: proxyUrl ? { server: proxyUrl, bypass: 'localhost,127.0.0.1' } : undefined,
});
try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    await page.goto(server.resolvedUrls.local[0] + (args.query ? '?' + args.query : ''));
    await page.waitForFunction(() => window.__slot?.map?.isStyleLoaded() && document.getElementById('loading')?.classList.contains('done'), null, { timeout: 60_000 });
    await page.evaluate(() => {
        const { car, track } = window.__slot;
        const step = car.step.bind(car);
        car.step = (dt, _c, live) => {
            if (window.__freeze) return;   // hold the pose while tiles load (rAF keeps ticking)
            const target = track.lerpArray(track.idealSpeed, car.s + car.v * 0.05);
            return step(dt, car.v < target ? { throttle: 1, brake: 0 } : { throttle: 0, brake: Math.min(1, (car.v - target) * 2) }, live);
        };
    });
    await page.evaluate(() => window.__slot.city);
    if (args.eval) await page.evaluate(args.eval);
    if (args.config) {
        await page.evaluate(cfg => { for (const [k, v] of Object.entries(cfg)) window.__slot.map.setConfigProperty('basemap', k, v); }, JSON.parse(args.config));
    }
    await page.click('#start-btn');
    await page.evaluate(() => window.__slot.advance(7.5));
    // keep shake deterministic-ish: no shake in stills
    await page.evaluate(() => { const c = window.__slot.camera; c.kick = () => {}; });
    for (const light of lights) {
        await page.evaluate(l => window.__slot.setLight?.(l), light);
        for (const mode of modes) {
            for (const s of SPOTS) {
                await page.evaluate(({ s, mode }) => {
                    const { car, track, camera } = window.__slot;
                    camera.modeIndex = mode;
                    car.reset(s - 25);
                    car.v = track.lerpArray(track.idealSpeed, s - 25);
                    camera.snap();
                    window.__freeze = false;
                    window.__slot.advance(1.2);
                    window.__freeze = true;
                }, { s, mode });
                // Let tiles for the new viewpoint stream in, keeping the frame static
                await page.waitForFunction(() => window.__slot.map.areTilesLoaded(), null, { timeout: 30_000, polling: 200 }).catch(() => {});
                await page.waitForTimeout(+(args.settle ?? 1500));
                await page.waitForFunction(() => window.__slot.map.areTilesLoaded(), null, { timeout: 30_000, polling: 200 }).catch(() => {});
                const file = path.join(outDir, `${light}-m${mode}-s${s}.png`);
                await page.screenshot({ path: file });
                console.log(file);
            }
        }
    }
    if (errors.length) console.log('console:\n  ' + [...new Set(errors)].slice(0, 15).join('\n  '));
} finally {
    await browser.close();
    await server.close();
}
