// Procedural sky used as the image-based-lighting environment (reflections on car
// paint and window glass). Colours follow the Mapbox light preset so reflections
// match the sky you actually see. Built Y-up like Three's stock environments; the
// caller rotates it into our Z-up world.

import * as THREE from 'three';

const SKIES = {
    day:   { zenith: '#3f7fd6', horizon: '#cfe3f5', ground: '#6d6a64', sun: '#fff4dc', sunDir: [0.45, 0.62, 0.64], sunPower: 6, city: 0 },
    dawn:  { zenith: '#4a5f9a', horizon: '#f4b99a', ground: '#4b4446', sun: '#ffc08a', sunDir: [0.8, 0.12, 0.58], sunPower: 4, city: 0.15 },
    dusk:  { zenith: '#1b2a5a', horizon: '#f08f6a', ground: '#2e2a36', sun: '#ff9a5c', sunDir: [-0.75, 0.06, 0.66], sunPower: 3, city: 0.5 },
    night: { zenith: '#050a1c', horizon: '#1d2748', ground: '#121218', sun: '#9fb2ff', sunDir: [0.3, 0.7, 0.6], sunPower: 0.6, city: 1 },
};

export function skyScene(preset) {
    const s = SKIES[preset] || SKIES.dusk;
    const d = new THREE.Vector3(...s.sunDir).normalize();
    const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
            zenith: { value: new THREE.Color(s.zenith) },
            horizon: { value: new THREE.Color(s.horizon) },
            ground: { value: new THREE.Color(s.ground) },
            sunCol: { value: new THREE.Color(s.sun) },
            sunDir: { value: d },
            sunPower: { value: s.sunPower },
            city: { value: s.city },
        },
        vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
            uniform vec3 zenith, horizon, ground, sunCol, sunDir; uniform float sunPower, city;
            varying vec3 vDir;
            float h(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
            void main() {
                vec3 d = normalize(vDir);
                float y = d.y;
                vec3 sky = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.55));
                // ground: darker below the horizon, with a band of distant city lights at night
                vec3 gnd = mix(horizon * 0.35 + ground * 0.4, ground, clamp(-y * 4.0, 0.0, 1.0));
                float az = atan(d.z, d.x);
                float band = smoothstep(-0.12, -0.01, y) * (1.0 - smoothstep(-0.01, 0.0, y));
                float lights = step(0.82, h(floor(vec2(az * 120.0, y * 300.0)))) * band * city;
                gnd += vec3(1.0, 0.8, 0.55) * lights * 1.5;
                vec3 c = y >= 0.0 ? sky : gnd;
                float sd = max(dot(d, sunDir), 0.0);
                c += sunCol * (pow(sd, 600.0) * sunPower * 8.0 + pow(sd, 12.0) * 0.35 * sunPower / 3.0);
                gl_FragColor = vec4(c, 1.0);
            }`,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat));
    return scene;
}
