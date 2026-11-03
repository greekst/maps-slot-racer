// Headless physics check: a bot follows the track's ideal speed profile.
// node tools/sim.mjs  → lap times, top speed, 0-100, de-slots
import fs from 'node:fs';
import { Track } from '../src/track.js';
import { SlotCar } from '../src/car.js';
import { PHYSICS_HZ } from '../src/config.js';
const def = JSON.parse(fs.readFileSync(new URL('../src/tracks/south-beach.json', import.meta.url)));
const track = new Track(def);
const car = new SlotCar(track);
const dt = 1 / PHYSICS_HZ;
const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
let t = 0, lastLap = 0, laps = 0, t100 = null, vmax = 0, deslots = 0;
const aggression = +(process.argv[2] ?? 1.0);
while (laps < 3 && t < 600) {
    const target = track.lerpArray(track.idealSpeed, car.s + car.v * 0.05) * aggression;
    const input = car.v < target ? { throttle: 1, brake: 0 } : { throttle: 0, brake: Math.min(1, (car.v - target) * 2) };
    car.step(dt, input, true);
    for (const e of car.events.splice(0)) if (e.type === 'deslot') { deslots++; console.log(`  DESLOT at ${track.wrap(e.s).toFixed(0)} m, ${(e.speed * 3.6).toFixed(0)} km/h`); }
    t += dt;
    if (t100 === null && car.v >= 100 / 3.6) t100 = t;
    vmax = Math.max(vmax, car.v);
    const lap = Math.floor(car.s / track.length);
    if (lap > laps - 0 && car.s > 0 && lap >= 1 && lap !== laps) { laps = lap; console.log(`lap ${laps}: ${fmt(t - lastLap)}`); lastLap = t; }
}
console.log(`0-100 km/h: ${t100?.toFixed(2)} s, top speed ${(vmax * 3.6).toFixed(0)} km/h, de-slots ${deslots}, ideal ${fmt(track.idealLapTime)}`);
