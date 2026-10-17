// Synergy City — places (STUB). Loads web/data/city.json and drops a glowing
// pillar for each point of interest, each one an interaction that opens the
// matching page. The content build models real cabinets/kiosks; the data and
// the "activate opens href" behaviour stay the same.
import * as THREE from '../../vendor/three/three.module.js';

export function buildPlaces(ctx, world) {
  const { scene, interactions, hud } = ctx;
  const group = new THREE.Group();
  group.name = 'places';
  scene.add(group);

  fetch(new URL('../../data/city.json', import.meta.url))
    .then((r) => r.json())
    .then((data) => {
      for (const place of data.places) {
        const color = new THREE.Color(place.color || '#c58bff');
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.6, 0.8, 3, 10),
          new THREE.MeshStandardMaterial({ color: 0x1a2140, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 }),
        );
        pillar.position.set(place.position[0], 1.5, place.position[1]);
        // A floating marker so it reads from across the plaza.
        const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), new THREE.MeshBasicMaterial({ color }));
        beacon.position.set(place.position[0], 3.6, place.position[1]);
        const light = new THREE.PointLight(color, 0.8, 14, 2);
        light.position.copy(beacon.position);
        group.add(pillar, beacon, light);

        const spin = { update(dt) { beacon.rotation.y += dt * 1.2; beacon.position.y = 3.6 + Math.sin(ctx.clock.time * 1.5) * 0.15; } };
        ctx.register(spin);

        interactions.add({
          position: [place.position[0], place.position[1]],
          radius: 4.5,
          label: place.label,
          hint: place.hint || 'Press E',
          onActivate: () => { hud.toast('Opening ' + place.label + '…'); location.href = place.href; },
        });
      }
    })
    .catch((e) => console.error('city places failed to load:', e));
}
