// Browser smoke test: boots the real app in headless Chromium and races two laps.
// node tools/smoke.mjs   (needs VITE_MAPBOX_TOKEN in the environment or .env)
//
// Checks:
//   1. no console errors / uncaught exceptions
//   2. the Mapbox style and tiles load (and no tile request fails)
//   3. a bot (same as tools/sim.mjs: follows the ideal speed profile) completes
//      laps via window.__slot.advance(), with the flying lap near the expected time
//
// Env overrides: SMOKE_EXPECT=85.8 (s), SMOKE_TOL=1.5 (s), SMOKE_SCREENSHOT=path.png,
//                CHROMIUM_PATH=/path/to/chrome
import { createRequire } from 'node:module';
import { createServer, loadEnv } from 'vite';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
    console.error('playwright not found: install it (npm i -D playwright) or put it on NODE_PATH');
    process.exit(2);
}

const root = new URL('..', import.meta.url).pathname;
const EXPECT = +(process.env.SMOKE_EXPECT ?? 85.8);   // flying lap, matches tools/sim.mjs
const TOL = +(process.env.SMOKE_TOL ?? 1.5);
const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;

const env = { ...loadEnv('development', root, 'VITE_'), ...process.env };
if (!env.VITE_MAPBOX_TOKEN) { console.error('FAIL: VITE_MAPBOX_TOKEN is not set'); process.exit(2); }

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures.push(msg); };

const server = await createServer({ root, logLevel: 'silent', server: { port: 0, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];

// Route the browser through the HTTPS proxy when one is configured (cloud sandboxes).
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    proxy: proxyUrl ? { server: proxyUrl, bypass: 'localhost,127.0.0.1' } : undefined,
});

let exitCode = 1;
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const consoleErrors = [];
    const failedTiles = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('response', r => {
        if (/api\.mapbox\.com/.test(r.url()) && r.status() >= 400) failedTiles.push(`${r.status()} ${r.url().split('?')[0]}`);
    });
    page.on('requestfailed', r => {
        if (/api\.mapbox\.com/.test(r.url())) failedTiles.push(`${r.failure()?.errorText} ${r.url().split('?')[0]}`);
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__slot?.map, null, { timeout: 30_000 });

    // Map: the app drops #loading after 'style.load'; then wait for style + visible tiles.
    // The map repaints every frame, so 'idle' never fires. Snapshot the state when it passes.
    const mapInfoFn = () => {
        const m = window.__slot.map;
        let layers = 0;
        try { layers = m.getStyle()?.layers?.length ?? 0; } catch { /* style not loaded */ }
        const info = {
            loader: document.getElementById('loading')?.classList.contains('done') ?? false,
            styleLoaded: m.isStyleLoaded(),
            tilesLoaded: m.areTilesLoaded(),
            trackLayers: !!(m.getLayer('track-slot') && m.getLayer('car-3d')),
            layers,
            webgl: !!m.painter?.context?.gl,
        };
        return info.loader && info.styleLoaded && info.tilesLoaded && info.trackLayers ? info : null;
    };
    let mapInfo = await page.waitForFunction(mapInfoFn, null, { timeout: 60_000, polling: 250 })
        .then(h => h.jsonValue(), () => null);
    const mapOk = !!mapInfo;
    mapInfo ??= await page.evaluate(`(${mapInfoFn})() ?? (() => { const m = window.__slot.map;
        return { styleLoaded: m.isStyleLoaded(), tilesLoaded: m.areTilesLoaded(), trackLayers: false, layers: 0, webgl: !!m.painter?.context?.gl }; })()`);
    check(mapOk,
        `map loaded (style ${mapInfo.styleLoaded}, tiles ${mapInfo.tilesLoaded}, track+car layers ${mapInfo.trackLayers}, WebGL ${mapInfo.webgl})`);
    // City dressing (src/city): buildings, road markings and street furniture built from vector tiles
    const city = await page.evaluate(async () => (await window.__slot.city)?.stats ?? null).catch(() => null);
    check(!!city && city.buildings > 500 && city.marks > 100 && city.lights > 50,
        `city built${city ? ` (${city.buildings} buildings, ${city.marks} markings, ${city.lights} lights, ${city.signals} signals, ${city.ms} ms)` : ''}`);
    check(failedTiles.length === 0, `Mapbox requests ok${failedTiles.length ? ': ' + failedTiles.slice(0, 5).join('; ') : ''}`);

    if (!mapOk) {
        check(false, 'race skipped: map did not load');
    } else {
        // Race: install the bot by wrapping car.step (tick() passes keyboard controls; we replace them),
        // start from the title screen, then advance game time deterministically.
        await page.evaluate(() => {
            const { car, track } = window.__slot;
            const step = car.step.bind(car);
            car.step = (dt, _controls, live) => {
                const target = track.lerpArray(track.idealSpeed, car.s + car.v * 0.05);
                const input = car.v < target ? { throttle: 1, brake: 0 } : { throttle: 0, brake: Math.min(1, (car.v - target) * 2) };
                return step(dt, input, live);
            };
            window.__smoke = { deslots: 0 };
            const origEvents = car.events;
            const push = origEvents.push.bind(origEvents);
            origEvents.push = (...es) => { for (const e of es) if (e.type === 'deslot') window.__smoke.deslots++; return push(...es); };
            window.__slot.timer.clearBest();   // ignore any best lap left in localStorage
        });
        await page.click('#start-btn');

        const result = await page.evaluate(() => {
            const { timer } = window.__slot;
            const laps = [];
            let seen = 0;
            for (let t = 0; t < 400 && laps.length < 2; t += 1) {
                window.__slot.advance(1);
                while (timer.lap - 1 > seen) { seen++; laps.push(timer.lastLap); }
            }
            return { laps, deslots: window.__smoke.deslots };
        });

        if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT });

        check(result.laps.length >= 2, `completed ${result.laps.length} laps: ${result.laps.map(fmt).join(', ')}`);
        check(result.deslots === 0, `de-slots: ${result.deslots}`);
        const flying = result.laps[1];
        check(flying != null && Math.abs(flying - EXPECT) <= TOL,
            `flying lap ${flying != null ? fmt(flying) : 'n/a'} within ±${TOL}s of ${fmt(EXPECT)}`);
    }
    check(consoleErrors.length === 0,
        `console errors: ${consoleErrors.length}${consoleErrors.length ? '\n      ' + consoleErrors.slice(0, 10).join('\n      ') : ''}`);

    exitCode = failures.length ? 1 : 0;
    console.log(exitCode ? `\nSMOKE FAILED (${failures.length})` : '\nSMOKE OK');
} catch (e) {
    console.error('FAIL ', e);
} finally {
    await browser.close();
    await server.close();
    process.exit(exitCode);
}
