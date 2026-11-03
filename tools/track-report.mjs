// Prints track stats for tuning: node tools/track-report.mjs [sigma]
import fs from 'node:fs';
import { Track } from '../src/track.js';
const def = JSON.parse(fs.readFileSync(new URL('../src/tracks/south-beach.json', import.meta.url)));
const sigma = process.argv[2] ? +process.argv[2] : undefined;
const t = new Track(def, sigma ? { smoothSigma: sigma } : {});
const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
console.log(`${t.name}: ${(t.length / 1000).toFixed(3)} km, ${t.n} samples, ideal lap ${fmt(t.idealLapTime)}`);
let vmax = 0; for (const v of t.idealSpeed) vmax = Math.max(vmax, v);
console.log(`top speed on ideal lap: ${(vmax * 3.6).toFixed(0)} km/h`);
for (const c of t.corners) console.log(`  ${c.name} ${c.dir} @ ${c.apex.toFixed(0)} m  radius ${c.radius.toFixed(1)} m  apex ${(c.vApex * 3.6).toFixed(0)} km/h`);
