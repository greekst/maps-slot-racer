// City dressing around the circuit: loads Mapbox Streets data and builds our own
// buildings, road markings and street furniture on top of Mapbox Standard.

import { loadCity, trackBBox } from './data.js';
import { buildBuildings } from './buildings.js';
import { buildRoadData, addRoadLayers } from './roads.js';
import { buildFurniture } from './furniture.js';

export const CITY_PAD = 700;   // metres of city loaded around the circuit's bounding box

// Distance (m) from (x, y) to the nearest track sample, via a coarse grid.
function trackDistance(track) {
    const CELL = 40, grid = new Map();
    for (let i = 0; i < track.n; i += 4) {
        const k = `${Math.floor(track.x[i] / CELL)},${Math.floor(track.y[i] / CELL)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
    }
    return (x, y) => {
        const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const i of grid.get(`${gx + dx},${gy + dy}`) || []) {
                best = Math.min(best, Math.hypot(track.x[i] - x, track.y[i] - y));
            }
        }
        return best;
    };
}

export async function buildCity({ map, track, carLayer, token }) {
    const t0 = performance.now();
    const city = await loadCity({ bbox: trackBBox(track, CITY_PAD), proj: track.proj, token });
    const dist = trackDistance(track);

    const roads = buildRoadData(city, track.proj);
    addRoadLayers(map, roads, track.proj.lat0, map.getLayer('track-band') ? 'track-band' : undefined);

    const buildings = buildBuildings(city.buildings, { busy: (x, y) => dist(x, y) < 30 });
    carLayer.addWorld(buildings, env => {
        buildings.material.userData.uniforms.uNight.value = env.lights;
    });

    const furniture = buildFurniture(city, { dist, nearJunction: roads.near });
    carLayer.addWorld(furniture.group, furniture.onLight, furniture.onFrame);

    const stats = {
        ...furniture.counts,
        ms: Math.round(performance.now() - t0), tiles: city.tiles, buildings: city.buildings.length,
        roads: city.roads.length, marks: roads.marks.features.length, signals: city.signals.length, crosswalks: city.crosswalks.length,
        triangles: buildings.geometry.index.count / 3,
    };
    console.info('[city]', stats);
    return { city, stats, dist };
}
