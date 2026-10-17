// Synergy City — places. The four points of interest, each a distinct landmark
// with a camera-facing label, a faked-bloom halo, and a proximity interaction
// that opens the matching page. Content from web/data/city.json; the data and
// the "activate opens href" behaviour match the skeleton's contract.
import * as THREE from '../../vendor/three/three.module.js';

export function buildPlaces(ctx, world) {
  const { scene, interactions, hud, register, clock } = ctx;
  const group = new THREE.Group();
  group.name = 'places';
  scene.add(group);

  const toDispose = [];
  const keep = (o) => { toDispose.push(o); return o; };

  // --- a crisp text label on a transparent canvas, shown as a camera-facing sprite ---
  function labelSprite(text, hint, hex) {
    const pad = 24;
    const W = 512;
    const H = 160;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    // pill background
    g.fillStyle = 'rgba(8,12,26,0.82)';
    const r = 28;
    g.beginPath();
    g.moveTo(pad + r, pad); g.arcTo(W - pad, pad, W - pad, H - pad, r);
    g.arcTo(W - pad, H - pad, pad, H - pad, r); g.arcTo(pad, H - pad, pad, pad, r);
    g.arcTo(pad, pad, W - pad, pad, r); g.closePath(); g.fill();
    g.strokeStyle = hex; g.lineWidth = 3; g.stroke();
    g.textAlign = 'center';
    g.fillStyle = '#eaf1ff';
    g.font = '600 40px "Space Grotesk", system-ui, sans-serif';
    g.fillText(text, W / 2, 74, W - pad * 3);
    g.fillStyle = hex;
    g.font = '500 26px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(hint, W / 2, 116, W - pad * 3);
    const tex = keep(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })));
    spr.scale.set(5.2, 1.625, 1);
    return spr;
  }

  function halo(color, size) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.3, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const tex = keep(new THREE.CanvasTexture(c));
    const spr = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: tex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 })));
    spr.scale.set(size, size, 1);
    return spr;
  }

  // --- the four landmark shapes, each returning a Group centred on the ground ---
  function arcadeCabinet(color) {
    const grp = new THREE.Group();
    const bodyMat = keep(new THREE.MeshStandardMaterial({ color: 0x141b33, roughness: 0.5, metalness: 0.2 }));
    const base = new THREE.Mesh(keep(new THREE.BoxGeometry(1.4, 2.4, 1.1)), bodyMat);
    base.position.y = 1.2;
    const screen = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.05, 0.8)), keep(new THREE.MeshStandardMaterial({ color: 0x06121a, emissive: color, emissiveIntensity: 1.1, roughness: 0.3 })));
    screen.position.set(0, 1.7, 0.57);
    const marquee = new THREE.Mesh(keep(new THREE.BoxGeometry(1.5, 0.4, 1.15)), keep(new THREE.MeshStandardMaterial({ color: 0x1a2342, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 })));
    marquee.position.y = 2.6;
    grp.add(base, screen, marquee);
    return grp;
  }
  function kiosk(color) {
    const grp = new THREE.Group();
    const post = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.18, 0.22, 1.4, 8)), keep(new THREE.MeshStandardMaterial({ color: 0x20284a, roughness: 0.5 })));
    post.position.y = 0.7;
    const panel = new THREE.Mesh(keep(new THREE.BoxGeometry(1.3, 0.85, 0.1)), keep(new THREE.MeshStandardMaterial({ color: 0x12182f, emissive: color, emissiveIntensity: 0.9, roughness: 0.3 })));
    panel.position.set(0, 1.55, 0);
    panel.rotation.x = -0.35;
    grp.add(post, panel);
    return grp;
  }
  function glassCube(color) {
    const grp = new THREE.Group();
    const plinth = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.9, 1.0, 0.5, 20)), keep(new THREE.MeshStandardMaterial({ color: 0x151b33, roughness: 0.6 })));
    plinth.position.y = 0.25;
    const cubeGeo = keep(new THREE.BoxGeometry(1.4, 1.4, 1.4));
    const cube = new THREE.Mesh(cubeGeo, keep(new THREE.MeshStandardMaterial({ color: 0x0c1f1a, transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.1, emissive: color, emissiveIntensity: 0.25 })));
    cube.position.y = 1.35;
    const edges = new THREE.LineSegments(keep(new THREE.EdgesGeometry(cubeGeo)), keep(new THREE.LineBasicMaterial({ color })));
    edges.position.y = 1.35;
    grp.add(plinth, cube, edges);
    return grp;
  }
  function gate(color) {
    const grp = new THREE.Group();
    const legMat = keep(new THREE.MeshStandardMaterial({ color: 0x1b2140, emissive: color, emissiveIntensity: 0.35, roughness: 0.5 }));
    const legGeo = keep(new THREE.BoxGeometry(0.5, 3, 0.5));
    const l = new THREE.Mesh(legGeo, legMat); l.position.set(-1.3, 1.5, 0);
    const r = new THREE.Mesh(legGeo, legMat); r.position.set(1.3, 1.5, 0);
    const top = new THREE.Mesh(keep(new THREE.BoxGeometry(3.3, 0.6, 0.5)), legMat); top.position.y = 3.2;
    const beam = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.4, 2.6)), keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));
    beam.position.y = 1.7;
    grp.add(l, r, top, beam);
    return grp;
  }
  const SHAPES = { arcade: arcadeCabinet, rulebook: kiosk, glassbox: glassCube, hangar: gate };

  fetch(new URL('../../data/city.json', import.meta.url))
    .then((r) => r.json())
    .then((data) => {
      for (const place of data.places) {
        const color = new THREE.Color(place.color || '#c58bff');
        const x = place.position[0];
        const z = place.position[1];
        const make = SHAPES[place.id] || kiosk;
        const landmark = make(color);
        landmark.position.set(x, 0, z);
        group.add(landmark);

        const h = halo(`rgb(${(color.r * 255) | 0},${(color.g * 255) | 0},${(color.b * 255) | 0})`, 4.5);
        h.position.set(x, 2.4, z);
        group.add(h);

        const label = labelSprite(place.label.replace(/ —.*$/, ''), place.hint || 'Press E', `#${color.getHexString()}`);
        label.position.set(x, 4.6, z);
        group.add(label);

        const light = new THREE.PointLight(color, 0.7, 16, 2);
        light.position.set(x, 3, z);
        group.add(light);

        register({ update() { landmark.rotation.y += 0.004; h.position.y = 2.4 + Math.sin(clock.time * 1.4) * 0.12; } });

        interactions.add({
          position: [x, z],
          radius: 5,
          label: place.label,
          hint: place.hint || 'Press E',
          onActivate: () => { hud.toast('Opening ' + place.label.replace(/ —.*$/, '') + '…'); location.href = place.href; },
        });
      }
    })
    .catch((e) => console.error('city places failed to load:', e));

  register({ dispose() { for (const o of toDispose) o.dispose?.(); } });
}
