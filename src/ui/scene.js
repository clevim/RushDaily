import * as THREE from '../vendor/three.module.js';

const GOLD = 0xf5b21a;
const CARD_W = 2.1;
const CARD_H = CARD_W * 614 / 421;

// maxRatio: o tapete e a home são tela cheia com fundo quase parado; em DPR 2 o custo é só de pixels (18 FPS contra 60 em DPR 1 no teste).
function makeRenderer(canvas, maxRatio = 2) {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, maxRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    return renderer;
  } catch {
    return null; // sem WebGL: a página continua funcionando sem a camada 3D
  }
}

function fit(renderer, camera, canvas) {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * renderer.getPixelRatio()) || canvas.height !== Math.round(height * renderer.getPixelRatio())) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

// SVG vira canvas em 2x para a textura não ficar borrada.
function imageTexture(url, renderer, scale = 2) {
  const texture = new THREE.Texture();
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 421 * scale;
    canvas.height = 614 * scale;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    texture.image = canvas;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
  };
  image.src = url;
  return texture;
}

function dust(count, spread, color = GOLD, size = 0.05) {
  const positions = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (Math.random() - 0.5) * spread.x;
    positions[index * 3 + 1] = (Math.random() - 0.5) * spread.y;
    positions[index * 3 + 2] = (Math.random() - 0.5) * spread.z;
    speeds[index] = 0.15 + Math.random() * 0.5;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, map: sparkTexture() });
  const points = new THREE.Points(geometry, material);
  points.userData.tick = (delta) => {
    const attribute = geometry.attributes.position;
    for (let index = 0; index < count; index += 1) {
      let y = attribute.getY(index) + speeds[index] * delta;
      if (y > spread.y / 2) y = -spread.y / 2;
      attribute.setY(index, y);
      attribute.setX(index, attribute.getX(index) + Math.sin(y * 2 + index) * 0.002);
    }
    attribute.needsUpdate = true;
  };
  return points;
}

let spark;
function sparkTexture() {
  if (spark) return spark;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,240,200,1)');
  gradient.addColorStop(0.25, 'rgba(255,190,60,0.8)');
  gradient.addColorStop(1, 'rgba(255,170,20,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  spark = new THREE.CanvasTexture(canvas);
  return spark;
}

function triangleOutline(size, thickness) {
  const outer = new THREE.Shape();
  const inner = new THREE.Path();
  const corner = (radius, angle) => [Math.cos(angle) * radius, Math.sin(angle) * radius];
  const angles = [Math.PI / 6, (5 * Math.PI) / 6, (3 * Math.PI) / 2]; // triângulo invertido, como no emblema
  angles.forEach((angle, index) => outer[index ? 'lineTo' : 'moveTo'](...corner(size, angle)));
  [...angles].reverse().forEach((angle, index) => inner[index ? 'lineTo' : 'moveTo'](...corner(size - thickness * 2, angle)));
  outer.holes.push(inner);
  return new THREE.ShapeGeometry(outer);
}

const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Leque 3D de cartas da home. `fronts`: 3 URLs de frente; `back`: URL do verso. */
/**
 * Leque 3D da home. O canvas cobre a tela inteira; o leque segue o elemento `anchor` (a coluna da direita)
 * e, ao entrar na arena, vai para o centro e voa contra a câmera sem ser cortado pela borda do canvas.
 */
export function homeScene(canvas, { fronts, back, reduced = false, anchor = null }) {
  const renderer = makeRenderer(canvas, 1.5);
  if (!renderer) return { launch: () => Promise.resolve(), setFronts() {} };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0.2, 11);

  scene.add(new THREE.AmbientLight(0xfff1d6, 0.9));
  const key = new THREE.DirectionalLight(0xffe2a8, 2.4);
  key.position.set(-4, 6, 8);
  scene.add(key);
  const rim = new THREE.PointLight(0x3fd1a8, 30, 20);
  rim.position.set(4, -2, -3);
  scene.add(rim);
  const glow = new THREE.PointLight(GOLD, 0, 14);
  glow.position.set(0, 0, 4);
  scene.add(glow);

  const rig = new THREE.Group();
  scene.add(rig);

  const sigil = new THREE.Group();
  const triangle = new THREE.Mesh(triangleOutline(3.1, 0.06), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.85 }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.55, 2.6, 96), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.35 }));
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(3.05, 3.07, 96), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.18 }));
  sigil.add(triangle, ring, ring2);
  sigil.position.set(0, 0.35, -1.4);
  rig.add(sigil);

  const backTexture = imageTexture(back, renderer);
  const edge = new THREE.MeshStandardMaterial({ color: 0xc98d18, metalness: 0.9, roughness: 0.3 });
  const geometry = new THREE.BoxGeometry(CARD_W, CARD_H, 0.03);
  const layout = [
    { x: -1.95, y: -0.25, z: -0.2, rz: 0.2 },
    { x: 0, y: 0.15, z: 0.25, rz: 0 },
    { x: 1.95, y: -0.25, z: -0.2, rz: -0.2 },
  ];
  const cards = fronts.slice(0, 3).map((front, index) => {
    const frontMaterial = new THREE.MeshStandardMaterial({ map: imageTexture(front, renderer), roughness: 0.42, metalness: 0.08, toneMapped: false });
    const backMaterial = new THREE.MeshStandardMaterial({ map: backTexture, roughness: 0.35, metalness: 0.25, toneMapped: false });
    // Faces da caixa: +x, -x, +y, -y, +z (verso), -z (frente; aparece ao girar 180°)
    const mesh = new THREE.Mesh(geometry, [edge, edge, edge, edge, backMaterial, frontMaterial]);
    mesh.userData = { ...layout[index], index, lift: 0 };
    rig.add(mesh);
    return mesh;
  });

  const particles = dust(reduced ? 0 : 260, { x: 16, y: 10, z: 8 });
  scene.add(particles);

  const pointer = new THREE.Vector2();
  const target = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const anchorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  let rigPlaced = false;
  let hovered = null;
  addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    target.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  }, { passive: true });

  const clock = new THREE.Clock();
  let intro = 0;
  let flipAt = null; // troca de frentes: só repete o giro, sem refazer a subida
  let launchAt = null;
  let launchDone = null;

  renderer.setAnimationLoop(() => {
    fit(renderer, camera, canvas);
    const delta = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime - intro;
    pointer.lerp(target, 0.06);

    raycaster.setFromCamera(target, camera);
    hovered = launchAt === null ? raycaster.intersectObjects(cards, false)[0]?.object || null : null;
    document.body.style.cursor = hovered ? 'grab' : '';

    rig.rotation.y = pointer.x * 0.28;
    rig.rotation.x = -pointer.y * 0.16;
    // Posição e tamanho: segue a âncora; no lançamento, centro da tela e um pouco maior.
    const view = canvas.getBoundingClientRect();
    const box = launchAt !== null || !anchor ? null : anchor.getBoundingClientRect();
    const screenX = box ? box.left + box.width / 2 : view.width / 2;
    const screenY = box ? box.top + box.height / 2 : view.height / 2;
    raycaster.setFromCamera(new THREE.Vector2((screenX / view.width) * 2 - 1, -(screenY / view.height) * 2 + 1), camera);
    const spot = raycaster.ray.intersectPlane(anchorPlane, new THREE.Vector3()) || new THREE.Vector3();
    const worldHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // Cabe na coluna pela altura (leque ~4.4 de altura) e pela largura (~7 de largura, contando a inclinação).
    const worldWidth = worldHeight * camera.aspect;
    const fanScale = box ? Math.min(1.05, Math.max(0.12, Math.min((box.height / view.height) * worldHeight / 4.4, (box.width / view.width) * worldWidth / 7))) : 1.15;
    if (!rigPlaced) { rig.position.copy(spot); rig.scale.setScalar(fanScale); rigPlaced = true; }
    rig.position.lerp(spot, launchAt !== null ? 0.12 : 0.25);
    rig.scale.setScalar(THREE.MathUtils.lerp(rig.scale.x, fanScale, 0.12));

    sigil.rotation.z = reduced ? 0 : Math.sin(time * 0.3) * 0.04;
    ring.scale.setScalar(1 + Math.sin(time * 1.6) * 0.015);

    cards.forEach((card) => {
      const { x, y, z, rz, index } = card.userData;
      const rise = reduced ? 1 : easeOutBack(clamp01((time - 0.15 - index * 0.14) / 0.9));
      // Na troca de frentes: vira de costas e volta para a frente nova, sem descer.
      const swap = flipAt === null ? 0 : clamp01((time - flipAt - index * 0.1) / 0.8);
      const flip = reduced ? 1 : flipAt === null ? easeInOut(clamp01((time - 1.15 - index * 0.16) / 0.7)) : 1 + easeInOut(swap) * 2;
      card.userData.lift += ((hovered === card ? 1 : 0) - card.userData.lift) * 0.12;
      const lift = card.userData.lift;
      const bob = reduced ? 0 : Math.sin(time * 1.1 + index * 1.7) * 0.06;
      card.position.set(x, y + (rise - 1) * 6 + bob + lift * 0.35, z + lift * 0.9);
      card.rotation.set(-lift * 0.08, Math.PI * flip + (index - 1) * 0.12, rz * (1 - lift * 0.6));

      if (launchAt !== null) {
        // 0-0.35s o leque vai ao centro; depois cada carta gira e voa contra a câmera
        const t = clamp01((time - launchAt - 0.35 - index * 0.07) / 0.8);
        const e = t * t * t;
        card.position.z += e * 10;
        card.position.x *= 1 - e;
        card.rotation.y += e * Math.PI * 4;
      }
    });

    if (launchAt !== null) {
      const t = clamp01((time - launchAt) / 1.3);
      glow.intensity = t * t * 260;
      if (t >= 1 && launchDone) { launchDone(); launchDone = null; }
    }

    particles.userData.tick?.(delta);
    renderer.render(scene, camera);
  });

  return {
    launch() {
      if (reduced) return Promise.resolve();
      launchAt = clock.elapsedTime - intro;
      return new Promise((resolve) => { launchDone = resolve; });
    },
    /** Troca as frentes e repete o giro (ex.: mudou a dificuldade). */
    setFronts(urls) {
      if (reduced) {
        cards.forEach((card, index) => { if (urls[index]) { card.material[5].map = imageTexture(urls[index], renderer); card.material[5].needsUpdate = true; } });
        return;
      }
      flipAt = clock.elapsedTime - intro;
      // A frente nova entra quando a carta está de costas (meio do giro).
      cards.forEach((card, index) => setTimeout(() => { if (urls[index]) { card.material[5].map = imageTexture(urls[index], renderer); card.material[5].needsUpdate = true; } }, 400 + index * 100));
    },
  };
}

function matTexture() {
  const size = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 80, size / 2, size / 2, size * 0.7);
  gradient.addColorStop(0, '#1e4b41');
  gradient.addColorStop(0.5, '#0f2a25');
  gradient.addColorStop(1, '#040c0a');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  // trama do feltro
  context.globalAlpha = 0.1;
  context.strokeStyle = '#000';
  for (let offset = -size; offset < size; offset += 9) {
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset + size, size);
    context.stroke();
  }
  // gravações douradas
  context.globalAlpha = 1;
  const c = size / 2;
  context.strokeStyle = 'rgba(245,178,26,0.4)';
  context.lineWidth = 5;
  context.beginPath();
  context.arc(c, c, 300, 0, Math.PI * 2);
  context.stroke();
  context.lineWidth = 2;
  context.strokeStyle = 'rgba(245,178,26,0.3)';
  [360, 520, 760].forEach((radius) => { context.beginPath(); context.arc(c, c, radius, 0, Math.PI * 2); context.stroke(); });
  context.lineWidth = 6;
  context.strokeStyle = 'rgba(245,178,26,0.38)';
  context.beginPath();
  for (let index = 0; index < 3; index += 1) {
    const angle = Math.PI / 2 + (index * 2 * Math.PI) / 3;
    context[index ? 'lineTo' : 'moveTo'](c + Math.cos(angle) * 270, c + Math.sin(angle) * 270);
  }
  context.closePath();
  context.stroke();
  context.lineWidth = 3;
  context.strokeStyle = 'rgba(245,178,26,0.35)';
  context.beginPath();
  context.moveTo(0, c);
  context.lineTo(c - 320, c);
  context.moveTo(c + 320, c);
  context.lineTo(size, c);
  context.stroke();
  for (let angle = 0; angle < 360; angle += 7.5) {
    const radians = (angle * Math.PI) / 180;
    context.beginPath();
    context.moveTo(c + Math.cos(radians) * 520, c + Math.sin(radians) * 520);
    context.lineTo(c + Math.cos(radians) * (angle % 30 ? 540 : 580), c + Math.sin(radians) * (angle % 30 ? 540 : 580));
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Tapete 3D da arena, com reações a eventos do duelo. */
export function duelScene(canvas, { reduced = false } = {}) {
  const noop = { pulse() {}, shake() {}, setTurn() {}, burst() {}, centerOn() {} };
  const renderer = makeRenderer(canvas, 1.5);
  if (!renderer) return noop;
  renderer.setClearColor(0x020605, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x020605, 12, 26);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
  const base = new THREE.Vector3(0, 9.5, 7.2);
  camera.position.copy(base);
  camera.lookAt(0, 0, 0.6);

  const mat = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), new THREE.MeshStandardMaterial({ map: matTexture(), roughness: 0.92, metalness: 0.05 }));
  mat.rotation.x = -Math.PI / 2;
  scene.add(mat);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const spot = new THREE.SpotLight(0xffe2a8, 160, 30, 0.6, 0.6);
  spot.position.set(0, 12, 2);
  spot.target.position.set(0, 0, 0);
  scene.add(spot, spot.target);
  const turnLight = new THREE.PointLight(GOLD, 40, 16);
  turnLight.position.set(0, 2.2, 3);
  scene.add(turnLight);

  const embers = dust(reduced ? 0 : 180, { x: 22, y: 8, z: 16 }, GOLD, 0.07);
  embers.position.y = 3;
  scene.add(embers);

  const waves = [];
  const matTarget = new THREE.Vector3();
  let matPlaced = false;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  let shake = 0;
  let turnColor = new THREE.Color(GOLD);
  const clock = new THREE.Clock();

  function toMat(x, y) {
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), camera);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3()) || new THREE.Vector3();
  }

  renderer.setAnimationLoop(() => {
    fit(renderer, camera, canvas);
    const delta = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    shake *= 0.88;
    camera.position.set(base.x + (Math.random() - 0.5) * shake, base.y + (Math.random() - 0.5) * shake * 0.6, base.z + (reduced ? 0 : Math.sin(time * 0.25) * 0.15));
    camera.lookAt(0, 0, 0.6);
    mat.position.lerp(matTarget, 0.08); // a mesa muda de altura quando o log quebra linha: o tapete acompanha sem pulo
    turnLight.color.lerp(turnColor, 0.05);
    turnLight.intensity = 40 + Math.sin(time * 2) * 6;
    for (let index = waves.length - 1; index >= 0; index -= 1) {
      const wave = waves[index];
      wave.age += delta;
      const t = wave.age / wave.life;
      wave.mesh.scale.setScalar(0.2 + t * wave.size);
      wave.mesh.material.opacity = (1 - t) * 0.9;
      wave.light.intensity = (1 - t) * wave.power;
      if (t >= 1) {
        scene.remove(wave.mesh, wave.light);
        wave.mesh.geometry.dispose();
        wave.mesh.material.dispose();
        waves.splice(index, 1);
      }
    }
    embers.userData.tick?.(delta);
    renderer.render(scene, camera);
  });

  return {
    /** Onda de choque no tapete, sob o ponto (x, y) da tela. */
    pulse(x, y, color = GOLD, size = 6, power = 120) {
      if (reduced) return;
      const point = toMat(x, y);
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(point.x, 0.02, point.z);
      const light = new THREE.PointLight(color, power, 8);
      light.position.set(point.x, 1.2, point.z);
      scene.add(mesh, light);
      waves.push({ mesh, light, age: 0, life: 0.9, size, power });
    },
    shake(amount = 0.35) { if (!reduced) shake = Math.max(shake, amount); },
    /** Põe o centro das gravações do tapete sob o ponto (x, y) da tela (o meio da mesa). */
    centerOn(x, y) {
      fit(renderer, camera, canvas);
      camera.updateMatrixWorld();
      const point = toMat(x, y);
      matTarget.set(point.x, 0, point.z);
      if (!matPlaced) { mat.position.copy(matTarget); matPlaced = true; } // 1ª vez no lugar; depois desliza
    },
    setTurn(owner) { turnColor = new THREE.Color(owner === 'enemy' ? 0xe0303f : GOLD); },
    burst(color = GOLD) {
      if (reduced) return;
      const rect = canvas.getBoundingClientRect();
      for (let index = 0; index < 5; index += 1) setTimeout(() => this.pulse(rect.width / 2, rect.height / 2, color, 10 + index * 3, 200), index * 140);
    },
  };
}

/* ---------- Reflexo metálico sem addons: um "céu" pintado em canvas vira envMap ---------- */
function studioEnvironment(renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const sky = context.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#fff4d0');
  sky.addColorStop(0.35, '#7a5a1e');
  sky.addColorStop(0.55, '#0c221d');
  sky.addColorStop(1, '#020605');
  context.fillStyle = sky;
  context.fillRect(0, 0, 512, 256);
  context.fillStyle = 'rgba(255,255,255,0.9)';
  context.fillRect(60, 40, 90, 26); // "softboxes" que desenham o brilho no metal
  context.fillRect(330, 56, 120, 18);
  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();
  return env;
}

function loadImage(url) {
  return new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = url; });
}

/** Faixas de selagem a quente (lacres) em cima e embaixo, com estrias verticais. */
function sealBands(context, width, height) {
  const band = Math.round(height * 0.072);
  for (const top of [0, height - band]) {
    const gradient = context.createLinearGradient(0, top, 0, top + band);
    gradient.addColorStop(0, '#7a5310');
    gradient.addColorStop(0.5, '#e8b440');
    gradient.addColorStop(1, '#7a5310');
    context.fillStyle = gradient;
    context.fillRect(0, top, width, band);
    context.fillStyle = 'rgba(0,0,0,0.28)';
    for (let x = 0; x < width; x += 9) context.fillRect(x, top, 3, band);
  }
}

/** Verso do pacote: foil escuro, emblema pequeno e o texto da embalagem. */
async function packBack(renderer, { mark }) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 1000;
  const context = canvas.getContext('2d');
  const base = context.createLinearGradient(0, 0, 640, 1000);
  base.addColorStop(0, '#1b0609');
  base.addColorStop(1, '#3a0d14');
  context.fillStyle = base;
  context.fillRect(0, 0, 640, 1000);
  sealBands(context, 640, 1000);
  const image = await loadImage(mark);
  if (image) { context.globalAlpha = 0.9; context.drawImage(image, 240, 230, 160, 160 * image.height / image.width); context.globalAlpha = 1; }
  context.textAlign = 'center';
  context.fillStyle = '#e8c070';
  context.font = '40px "Dela Gothic One", "Arial Black", sans-serif';
  context.fillText('RUSHDAILY', 320, 480);
  context.fillStyle = '#c9b89a';
  context.font = '600 26px "Archivo", sans-serif';
  ['5 cartas por pacote', '4 comuns e 1 rara', 'Cartas com foil especial', 'Fan game não oficial'].forEach((line, index) => context.fillText(line, 320, 560 + index * 40));
  context.fillStyle = '#e8e0d0';
  for (let x = 0; x < 180; x += 6) context.fillRect(230 + x, 780, (x * 7) % 5 + 1, 70); // "código de barras"
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

/** Máscara alfa do pacote: serrilha fina nos lacres e, se pedido, só um lado da linha de rasgo. */
function packMask(tearV, keep) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 768;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 512, 768);
  context.fillStyle = '#000';
  const teeth = (y, dir) => {
    context.beginPath();
    context.moveTo(0, y);
    for (let x = 0; x <= 512; x += 8) context.lineTo(x, y + (x / 8 % 2 ? 7 : 0) * dir);
    context.lineTo(512, y - 40 * dir);
    context.lineTo(0, y - 40 * dir);
    context.fill();
  };
  teeth(2, 1); // topo
  teeth(766, -1); // base
  if (keep) {
    // Linha de rasgo serrilhada irregular (mesma para corpo e tira). Os pontos vão até x=512 exato:
    // parar em 506 e fechar no canto deixava uma tira branca diagonal fininha.
    const y = (1 - tearV) * 768;
    const corner = keep === 'body' ? 0 : 768;
    context.beginPath();
    context.moveTo(0, corner);
    for (let x = 0; x < 512 + 22; x += 22) { const px = Math.min(x, 512); context.lineTo(px, y + (x / 22 % 2 ? 9 : -9) + Math.sin(x * 0.37) * 4); }
    context.lineTo(512, corner);
    context.closePath();
    context.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

/** Mapa de normais de "amassado": manchas e vincos suaves, para a luz desenhar rugas no foil. */
function wrinkleNormals() {
  const width = 256;
  const height = 384;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#808080';
  context.fillRect(0, 0, width, height);
  context.filter = 'blur(6px)';
  for (let index = 0; index < 60; index += 1) {
    context.strokeStyle = `rgba(${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},0.25)`;
    context.lineWidth = 2 + Math.random() * 6;
    context.beginPath();
    const x = Math.random() * width;
    const y = Math.random() * height;
    context.moveTo(x, y);
    context.quadraticCurveTo(x + (Math.random() - 0.5) * 120, y + (Math.random() - 0.5) * 120, x + (Math.random() - 0.5) * 160, y + (Math.random() - 0.5) * 220);
    context.stroke();
  }
  const height01 = context.getImageData(0, 0, width, height).data;
  const out = context.createImageData(width, height);
  const h = (x, y) => height01[(((y + height) % height) * width + ((x + width) % width)) * 4] / 255;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 2.5;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 2.5;
      const index = (y * width + x) * 4;
      out.data[index] = 128 - dx * 127;
      out.data[index + 1] = 128 + dy * 127;
      out.data[index + 2] = 255;
      out.data[index + 3] = 255;
    }
  }
  context.putImageData(out, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

/** Malha de um lado do pacote: estufada como travesseiro e estriada nos lacres (estrias com >4 vértices por ciclo, sem serrilhado). */
function pouchGeometry(width, height, crimp) {
  const geometry = new THREE.PlaneGeometry(width, height, 96, 64);
  const position = geometry.attributes.position;
  const inner = height / 2 - crimp;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const u = Math.abs(x) / (width / 2);
    const v = Math.min(1, Math.abs(y) / inner);
    const belly = (1 - u ** 4) * (1 - v ** 4); // 0 nas bordas e nos lacres
    const ripple = Math.sin(x * 55) * 0.006 * (1 - belly) * (Math.abs(y) > inner ? 1 : 0); // estrias só no lacre
    position.setZ(index, 0.01 + 0.17 * belly + ripple);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------- Booster: estilos por raridade ---------- */

export const PACK_TIERS = {
  common: { label: 'Booster', base: ['#2a0a10', '#5a1420', '#14050a'], ray: '245,178,26', frame: '#f5b21a', title: '#ffe596', iridescence: 0.4, metalness: 0.6, glow: 0xf5b21a, opening: 'tear' },
  silver: { label: 'Booster Prata', base: ['#1c2128', '#7d8a9b', '#20262e'], ray: '230,240,255', frame: '#e8f0ff', title: '#ffffff', iridescence: 0.7, metalness: 0.85, glow: 0xcfe3ff, opening: 'spin' },
  gold: { label: 'Booster Ouro', base: ['#3a2404', '#d99a1e', '#2a1a03'], ray: '255,243,196', frame: '#fff3c4', title: '#fff8e0', iridescence: 0.5, metalness: 0.95, glow: 0xffd36b, opening: 'beams' },
  galaxy: { label: 'Booster Galáxia', base: ['#080418', '#3a1a7a', '#05142e'], ray: '201,181,255', frame: '#c9b5ff', title: '#f0e8ff', iridescence: 1, metalness: 0.7, glow: 0x9a7bff, opening: 'supernova', stars: true },
};

/** Frente do pacote desenhada em canvas, nas cores da raridade. */
async function packFace(renderer, { mark, title, subtitle, tier = PACK_TIERS.common }) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 1000;
  const context = canvas.getContext('2d');
  const base = context.createLinearGradient(0, 0, 640, 1000);
  base.addColorStop(0, tier.base[0]);
  base.addColorStop(0.5, tier.base[1]);
  base.addColorStop(1, tier.base[2]);
  context.fillStyle = base;
  context.fillRect(0, 0, 640, 1000);
  context.save();
  context.translate(320, 420);
  for (let index = 0; index < 48; index += 1) {
    context.rotate(Math.PI / 24);
    context.fillStyle = `rgba(${tier.ray},${index % 2 ? 0.1 : 0.03})`;
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(900, -40);
    context.lineTo(900, 40);
    context.fill();
  }
  context.restore();
  if (tier.stars) {
    for (let index = 0; index < 220; index += 1) {
      context.fillStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.8})`;
      const size = Math.random() < 0.1 ? 3 : 1.5;
      context.fillRect(Math.random() * 640, 80 + Math.random() * 840, size, size);
    }
  }
  sealBands(context, 640, 1000);
  context.strokeStyle = tier.frame;
  context.lineWidth = 8;
  context.strokeRect(30, 96, 580, 808);
  context.lineWidth = 3;
  context.strokeRect(46, 112, 548, 776);
  const image = await loadImage(mark);
  if (image) context.drawImage(image, 140, 210, 360, 360 * image.height / image.width);
  context.textAlign = 'center';
  context.fillStyle = tier.title;
  // Nomes longos (BOOSTER GALÁXIA) encolhem até caber na moldura.
  let size = 72;
  do { context.font = `${size}px "Dela Gothic One", "Arial Black", sans-serif`; size -= 2; } while (context.measureText(title).width > 520 && size > 30);
  context.fillText(title, 320, 720);
  context.fillStyle = '#f4ecdc';
  context.font = '700 34px "Archivo", sans-serif';
  context.fillText(subtitle, 320, 790, 540);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

/**
 * Pacote 3D (frente + verso estufados, lacres serrilhados, tira de rasgo separada), na aparência `look`.
 * Compartilhado pela abertura (boosterScene) e pela vitrine das raridades (tierShowcase).
 */
const W = 2.4; // pacote: largura, altura e altura da linha de rasgo acima do centro
const H = 3.6;
const TEAR = 1.3;
let wrinkleTexture = null;
function buildPack(renderer, { mark, subtitle, look }) {
  const CRIMP = 0.26;
  const group = new THREE.Group();
  wrinkleTexture ||= wrinkleNormals();
  const foilMaterial = (alphaMap) => new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: look.metalness, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12,
    iridescence: look.iridescence, iridescenceIOR: 1.5, iridescenceThicknessRange: [250, 700],
    normalMap: wrinkleTexture, normalScale: new THREE.Vector2(0.35, 0.35), alphaMap, alphaTest: 0.5, side: THREE.DoubleSide, transparent: true, // transparent desde o início: ligar no meio da abertura recompilava o shader e travava a animação
  });
  const tearV = (TEAR + H / 2) / H;
  const mirrored = (texture) => { texture.wrapS = THREE.RepeatWrapping; texture.repeat.x = -1; return texture; };
  const frontBody = foilMaterial(packMask(tearV, 'body'));
  const frontStrip = foilMaterial(packMask(tearV, 'strip'));
  const backBody = foilMaterial(mirrored(packMask(tearV, 'body')));
  const backStrip = foilMaterial(mirrored(packMask(tearV, 'strip')));
  const packMaterials = [frontBody, frontStrip, backBody, backStrip];
  const applyFace = (style) => packFace(renderer, { mark, title: style.label.toUpperCase(), subtitle, tier: style }).then((texture) => {
    for (const material of [frontBody, frontStrip]) { material.map = texture; material.needsUpdate = true; }
  });
  applyFace(look);
  packBack(renderer, { mark }).then((texture) => {
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = -1;
    for (const material of [backBody, backStrip]) { material.map = texture; material.needsUpdate = true; }
  });
  const side = pouchGeometry(W, H, CRIMP);
  const face = (material, back) => { const mesh = new THREE.Mesh(side, material); if (back) mesh.rotation.y = Math.PI; return mesh; };
  const body = new THREE.Group();
  body.add(face(frontBody, false), face(backBody, true));
  const strip = new THREE.Group();
  strip.position.set(-W / 2, TEAR, 0);
  const stripFaces = new THREE.Group();
  stripFaces.position.set(W / 2, -TEAR, 0);
  stripFaces.add(face(frontStrip, false), face(backStrip, true));
  strip.add(stripFaces);
  group.add(body, strip);
  return { group, strip, packMaterials, applyFace };
}

/** Acabamento físico da frente de cada carta revelada, conforme o foil sorteado. */
function cardFrontMaterial(map, foil) {
  const settings = {
    star: { iridescence: 0.35, roughness: 0.3 },
    etched: { iridescence: 0.3, roughness: 0.35 },
    prism: { iridescence: 0.85, roughness: 0.22 },
    gold: { iridescence: 0.25, roughness: 0.2, sheen: 1, sheenColor: new THREE.Color(0xffc84a) },
    galaxy: { iridescence: 1, roughness: 0.18, iridescenceThicknessRange: [100, 900] },
  }[foil] || { iridescence: 0, roughness: 0.4 };
  return new THREE.MeshPhysicalMaterial({ map, clearcoat: 1, clearcoatRoughness: 0.1, metalness: 0.05, toneMapped: false, iridescenceIOR: 1.6, ...settings });
}

const FOIL_COLOR = { star: 0xbfe6ff, etched: 0xffffff, prism: 0xff8ae6, gold: 0xffd36b, galaxy: 0x9a7bff };

/**
 * Booster 3D completo: pacote (estilo e abertura da raridade), cartas saindo do pacote e revelação em 3D.
 * cards: [{ front, back, foil, rare }]. disguise: o pacote aparece comum e evolui no clique.
 * opened: mostra as cartas já reveladas (revisitar). onInspect(i) ao tocar numa carta revelada.
 * piece: { index, total } — a peça do dia do Enigma desce sobre as cartas quando todas foram viradas; onPiece ao tocar nela.
 */
export function boosterScene(canvas, { mark, subtitle, tier: tierId = 'common', cards: cardData = [], disguise = false, opened = false, layout = 'arc', reduced = false, onInspect = null, onAllRevealed = null, piece = null, onPiece = null }) {
  const renderer = makeRenderer(canvas);
  const fallback = { open: () => Promise.resolve(), revealAll() {}, cardAt: () => null };
  if (!renderer) return fallback;
  const tier = PACK_TIERS[tierId] || PACK_TIERS.common;
  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 10);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffe2a8, 2.2);
  key.position.set(-3, 4, 6);
  scene.add(key);
  const burst = new THREE.PointLight(tier.glow, 0, 14);
  burst.position.set(0, 1.5, 2.5);
  scene.add(burst);

  // ----- Pacote: frente e verso estufados, lacres e linha de rasgo -----
  const { group, strip, packMaterials, applyFace } = buildPack(renderer, { mark, subtitle, look: disguise ? PACK_TIERS.common : tier });
  scene.add(group);
  group.visible = !opened;

  // Raios de luz (Ouro): planos aditivos saindo da costura.
  const beams = new THREE.Group();
  if (tier.opening === 'beams') {
    for (let index = 0; index < 7; index += 1) {
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 4), new THREE.MeshBasicMaterial({ color: tier.glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      beam.geometry.translate(0, 2, 0);
      beam.position.set(-1 + index * 0.33, TEAR, 0.2);
      beam.rotation.z = (index - 3) * 0.16;
      beams.add(beam);
    }
    group.add(beams);
  }

  // ----- Partículas: estouros reaproveitáveis -----
  const bursts = [];
  function spark(origin, color, count = 70, speed = 3, gravity = 5) {
    if (reduced) return;
    const positions = new Float32Array(count * 3);
    const velocity = [];
    for (let index = 0; index < count; index += 1) {
      positions.set([origin.x, origin.y, origin.z], index * 3);
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.3).normalize();
      velocity.push(direction.multiplyScalar(speed * (0.4 + Math.random())));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size: 0.09, map: sparkTexture(), transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(points);
    bursts.push({ points, velocity, age: 0, gravity });
  }

  // ----- Cartas: caixinhas finas, verso para a câmera; viram ao serem tocadas -----
  const CARD_W = 1.42;
  const CARD_H = CARD_W * 614 / 421;
  const edge = new THREE.MeshStandardMaterial({ color: 0xc98d18, metalness: 0.9, roughness: 0.3 });
  const count = cardData.length;
  const slots = cardData.map((_, index) => {
    const offset = index - (count - 1) / 2;
    const lower = piece ? -0.5 : 0; // abre espaço para a peça do Enigma acima das cartas
    if (layout === 'row') return { x: offset * 1.62, y: -0.1 + lower, z: 0, rz: 0 };
    return { x: offset * 1.58, y: 0.15 - offset * offset * 0.09 + lower, z: -Math.abs(offset) * 0.12, rz: -offset * 0.07 };
  });
  const cards = cardData.map((data, index) => {
    const back = new THREE.MeshStandardMaterial({ map: imageTexture(data.back, renderer), roughness: 0.35, metalness: 0.25, toneMapped: false });
    const front = cardFrontMaterial(imageTexture(data.front, renderer), data.foil);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, CARD_H, 0.025), [edge, edge, edge, edge, back, front]);
    mesh.userData = { index, revealAt: opened ? -10 : null, hover: 0, data };
    mesh.visible = opened;
    if (opened) { const slot = slots[index]; mesh.position.set(slot.x, slot.y, slot.z); mesh.rotation.set(0, Math.PI, slot.rz); }
    scene.add(mesh);
    return mesh;
  });
  // Aura das raras: um brilho atrás do verso enquanto não for revelada.
  const auras = cards.map((card) => {
    if (!card.userData.data.rare) return null;
    const aura = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W * 1.5, CARD_H * 1.35), new THREE.MeshBasicMaterial({ map: sparkTexture(), color: FOIL_COLOR[card.userData.data.foil] || tier.glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    aura.position.z = -0.05;
    card.add(aura);
    return aura;
  });

  const particles = dust(reduced ? 0 : 160, { x: 10, y: 8, z: 6 });
  scene.add(particles);

  const target = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  let hovered = null;
  const toNdc = (event) => {
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  };
  addEventListener('pointermove', (event) => { target.copy(toNdc(event)); }, { passive: true });
  const clock = new THREE.Clock();
  let openedAt = null;
  let cardsAt = opened ? -10 : null;
  let done = null;
  let revealedCount = opened ? count : 0;
  let shake = 0;
  // Duração da fase do pacote por estilo de abertura (+0.7s se o pacote evoluir antes).
  const packPhase = { tear: 1.5, spin: 1.9, beams: 2.1, supernova: 1.8 }[tier.opening] + (disguise ? 0.8 : 0);

  // Peça do dia do Enigma: a peça real do modelo, em ouro, descendo sobre as cartas.
  const piecePivot = new THREE.Group();
  piecePivot.visible = false;
  scene.add(piecePivot);
  let pieceMaterial = null;
  let pieceAt = null;
  if (piece) {
    loadPuzzle('src/assets/puzzle/').then(({ meta, pieces: parts }) => {
      const chosen = groupPieces(parts, piece.total)[piece.index];
      if (!chosen) return;
      pieceMaterial = puzzleMaterial(meta.shape);
      const mesh = new THREE.Mesh(geometryOf(...chosen.arrays), pieceMaterial);
      mesh.position.set(...chosen.center.map((value) => -value)); // gira em torno do próprio centro; o shader segue nas coordenadas do enigma
      piecePivot.add(mesh);
      const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).length();
      piecePivot.scale.setScalar(Math.min(5, 2.4 / Math.max(0.2, size)));
      // Halo dourado atrás da peça.
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: sparkTexture(), color: 0xffd36b, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.position.set(0, 1.95, 0.3);
      halo.visible = false;
      piecePivot.userData.halo = halo;
      scene.add(halo);
      if (opened) showPiece();
    });
  }
  function showPiece() {
    if (!piece || pieceAt !== null) return;
    pieceAt = clock.elapsedTime;
  }

  function reveal(card) {
    if (!card || card.userData.revealAt !== null || cardsAt === null) return;
    card.userData.revealAt = clock.elapsedTime;
    revealedCount += 1;
    if (revealedCount === count) setTimeout(() => { onAllRevealed?.(); showPiece(); }, 700);
  }
  canvas.addEventListener('click', (event) => {
    if (cardsAt === null) return;
    raycaster.setFromCamera(toNdc(event), camera);
    if (piecePivot.visible && raycaster.intersectObject(piecePivot, true).length) { onPiece?.(); return; }
    const hit = raycaster.intersectObjects(cards, false)[0]?.object;
    if (!hit) return;
    if (hit.userData.revealAt === null) reveal(hit);
    else onInspect?.(hit.userData.index);
  });

  const ease = (t) => 1 - (1 - t) ** 3;
  let cameraZ = 10;
  renderer.setAnimationLoop(() => {
    fit(renderer, camera, canvas);
    const delta = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    shake *= 0.9;
    // Tela em pé: depois de aberto, afasta a câmera até as 5 cartas caberem na largura (~8.8 de mundo).
    const fitZ = Math.max(piece ? 8.6 : 7.5, (camera.aspect < 0.8 ? 8.1 : 8.8) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect)); // piso 7,5: em tela larga as cartas ficam grandes sem passar da altura do palco
    cameraZ += ((opened || openedAt !== null ? fitZ : 10) - cameraZ) * (reduced ? 1 : 0.06);
    camera.position.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, cameraZ);
    camera.lookAt(0, piece && (opened || openedAt !== null) ? 0.5 : 0, 0); // com a peça do Enigma, enquadra um pouco acima para ela caber

    if (openedAt === null) {
      group.rotation.y += ((target.x * 0.6 + (reduced ? 0 : Math.sin(time * 0.6) * 0.25)) - group.rotation.y) * 0.08;
      group.rotation.x += ((-target.y * 0.3) - group.rotation.x) * 0.08;
      group.position.y = reduced ? 0 : Math.sin(time * 1.2) * 0.12;
    } else if (group.visible) {
      let t = time - openedAt;
      // Evolução: o pacote comum treme, clareia e vira a raridade de verdade.
      if (disguise) {
        if (t < 0.8) {
          group.position.x = Math.sin(t * 70) * 0.03 * t;
          burst.intensity = t * 260;
          if (t > 0.45 && !group.userData.evolved) {
            group.userData.evolved = true;
            applyFace(tier);
            for (const material of packMaterials) { material.metalness = tier.metalness; material.iridescence = tier.iridescence; }
            spark(new THREE.Vector3(0, 0, 0.4), tier.glow, 120, 4, 1);
            shake = 0.25;
          }
          renderer.render(scene, camera);
          return;
        }
        t -= 0.8;
      }
      group.rotation.set(group.rotation.x * 0.9, group.rotation.y * 0.9, 0);
      if (tier.opening === 'spin') {
        // Prata: um giro completo antes de rasgar.
        const k = Math.min(1, t / 0.6);
        group.rotation.y = ease(k) * Math.PI * 2;
        t = Math.max(0, t - 0.4);
      }
      if (tier.opening === 'beams') {
        // Ouro: tremor crescente e raios saindo da costura, então a tira explode para cima.
        const charge = Math.min(1, t / 0.9);
        group.position.x = Math.sin(t * 80) * 0.05 * charge;
        beams.children.forEach((beam, index) => { beam.material.opacity = charge * (0.35 + 0.25 * Math.sin(t * 20 + index)); beam.scale.y = 0.3 + charge; });
        burst.intensity = charge * 240;
        if (t > 0.9 && !beams.userData.blown) { beams.userData.blown = true; spark(new THREE.Vector3(0, TEAR, 0.3), tier.glow, 140, 5, 4); shake = 0.3; }
        t = Math.max(0, t - 0.6);
      }
      if (tier.opening === 'supernova') {
        // Galáxia: o pacote se contrai, brilha e explode em estrelas.
        const k = Math.min(1, t / 0.9);
        group.scale.setScalar(Math.max(0.001, (1 - 0.25 * Math.sin(k * Math.PI / 2) + (t > 0.9 ? (t - 0.9) * 2 : 0)) * (t > 0.9 ? 1 - Math.min(1, (t - 0.9) * 4) : 1))); // some encolhendo: opacity + alphaTest faria o pacote piscar e sumir de uma vez
        burst.intensity = k * 320;
        if (t > 0.9 && !group.userData.nova) {
          group.userData.nova = true;
          spark(new THREE.Vector3(0, 0, 0.3), tier.glow, 220, 6, 0.5);
          spark(new THREE.Vector3(0, 0, 0.3), 0xffffff, 120, 4, 0.5);
          shake = 0.4;
        }
        if (t > 1.2) group.visible = false;
      } else {
        // Rasgo (comum, prata e ouro): a tira descasca e solta, com lascas.
        const k = Math.min(1, t / (tier.opening === 'beams' ? 0.5 : 1.1));
        // Rasgo em duas fases: a tira descasca da costura (ease in-out) e depois se solta em arco, girando.
        const peel = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
        const loose = Math.max(0, (k - 0.5) / 0.5);
        const looseE = loose * loose;
        const fly = tier.opening === 'beams' ? 3 : 1.6;
        strip.rotation.set(-peel * 0.5 - looseE * 0.6, peel * 0.7 + looseE * 0.5, peel * 0.9 + looseE * 1.4);
        strip.position.set(-1.2 + looseE * 1.4, TEAR + Math.sin(loose * Math.PI * 0.5) * fly * 0.7 + looseE * fly * 0.3, peel * 0.45 + looseE * 0.9);
        if (t > 0.05 && !strip.userData.cracked) { strip.userData.cracked = true; spark(new THREE.Vector3(0, TEAR, 0.2), 0xffd36b, 80, 2.5, 6); }
        if (tier.opening !== 'beams') burst.intensity = Math.sin(Math.min(1, k) * Math.PI) * 180;
        // A tira se solta e o pacote vazio escorrega para baixo encolhendo (sem fade: opacity + alphaTest faz o pacote piscar).
        const leave = Math.max(0, (t - 1.0) / 0.8);
        const out = leave * leave * (3 - 2 * leave);
        group.position.y = -out * 3.8;
        group.rotation.z = out * 0.25;
        group.scale.setScalar(Math.max(0.001, 1 - out));
        strip.scale.setScalar(Math.max(0.001, 1 - looseE * 0.35));
        beams.children.forEach((beam) => { beam.material.opacity *= 0.92; });
        if (leave >= 1) group.visible = false;
      }
      if (cardsAt === null && time - openedAt > packPhase - 0.6) cardsAt = time;
    }

    // Cartas: saem do pacote (pela boca rasgada, ou do centro na supernova) até o lugar, uma a uma.
    raycaster.setFromCamera(target, camera);
    hovered = cardsAt === null ? null : raycaster.intersectObjects(cards, false)[0]?.object || null;
    const overPiece = piecePivot.visible && raycaster.intersectObject(piecePivot, true).length > 0;
    canvas.style.cursor = hovered || overPiece ? 'pointer' : '';
    cards.forEach((card, index) => {
      if (cardsAt === null) return;
      const slot = slots[index];
      const k = Math.min(1, Math.max(0, (time - cardsAt - index * 0.14) / 0.75));
      if (k <= 0) return;
      card.visible = true;
      const e = ease(k);
      const from = tier.opening === 'supernova' ? new THREE.Vector3(0, 0, 0.5) : new THREE.Vector3(0, 0.9, -0.1);
      const control = tier.opening === 'supernova' ? new THREE.Vector3(Math.cos(index * 1.3) * 3, Math.sin(index * 1.3) * 2, 1.5) : new THREE.Vector3(slot.x * 0.4, 3.2, 0.6);
      const position = new THREE.Vector3().copy(from).multiplyScalar((1 - e) ** 2).add(control.clone().multiplyScalar(2 * (1 - e) * e)).add(new THREE.Vector3(slot.x, slot.y, slot.z).multiplyScalar(e * e));
      card.userData.hover += ((hovered === card ? 1 : 0) - card.userData.hover) * 0.15;
      const bob = reduced ? 0 : Math.sin(time * 1.3 + index) * 0.04 * e;
      // Virada: meia-volta com elevação; no meio do giro, estouro na cor do foil.
      let flip = 0;
      let lift = card.userData.hover * 0.25;
      if (card.userData.revealAt !== null) {
        const f = Math.min(1, (time - card.userData.revealAt) / (card.userData.data.rare ? 0.9 : 0.6));
        flip = card.userData.revealAt < 0 ? 1 : 0.5 - Math.cos(f * Math.PI) / 2;
        lift += Math.sin(f * Math.PI) * (card.userData.data.rare ? 1.2 : 0.6);
        if (f > 0.5 && !card.userData.sparked && card.userData.revealAt >= 0) {
          card.userData.sparked = true;
          const color = FOIL_COLOR[card.userData.data.foil] || 0xffffff;
          spark(card.position.clone().add(new THREE.Vector3(0, 0, 0.3)), color, card.userData.data.rare ? 160 : 60, card.userData.data.rare ? 4 : 2.5, 3);
          if (card.userData.data.rare) { shake = 0.22; burst.color.set(color); burst.intensity = 220; }
        }
      }
      card.position.set(position.x, position.y + bob, position.z + lift);
      const spin = tier.opening === 'supernova' ? (1 - e) * Math.PI * 3 : (1 - e) * 0.8;
      card.rotation.set(-card.userData.hover * 0.08, Math.PI * flip + spin + target.x * 0.15 * e, slot.rz * e * (1 - card.userData.hover * 0.6));
      card.scale.setScalar((0.8 + 0.2 * e) * (1 + card.userData.hover * 0.06 + (card.userData.revealAt !== null && card.userData.revealAt >= 0 ? Math.sin(Math.min(1, (time - card.userData.revealAt) / 0.6) * Math.PI) * 0.12 : 0)));
      const aura = auras[index];
      if (aura) aura.material.opacity = card.userData.revealAt === null ? (0.35 + Math.sin(time * 4) * 0.2) * e : Math.max(0, aura.material.opacity - delta * 1.5);
    });
    if (cardsAt !== null && done && time - cardsAt > 0.75 + count * 0.14) { done(); done = null; }

    // A peça desce girando do alto até ficar sobre as cartas, com estouro dourado ao chegar.
    if (pieceAt !== null && piecePivot.children.length) {
      piecePivot.visible = true;
      const k = opened ? 1 : Math.min(1, (time - pieceAt) / 1.1);
      const e = ease(k);
      piecePivot.position.set(0, 4.6 - e * 2.65, 0.5 + e * 0.4);
      const halo = piecePivot.userData.halo;
      if (halo) { halo.visible = true; halo.material.opacity = e * (0.45 + Math.sin(time * 3) * 0.12); halo.position.y = piecePivot.position.y; }
      piecePivot.rotation.set(0.35, time * 0.9 + (1 - e) * 6, (1 - e) * 1.2);
      if (k >= 1 && !piecePivot.userData.landed) {
        piecePivot.userData.landed = true;
        if (!opened) { spark(piecePivot.position.clone(), 0xffd36b, 150, 3.5, 2); burst.color.set(0xffd36b); burst.intensity = 240; }
      }
      if (pieceMaterial) pieceMaterial.userData.uniforms.uTime.value = time;
    }

    burst.intensity *= 0.97;
    for (let index = bursts.length - 1; index >= 0; index -= 1) {
      const item = bursts[index];
      item.age += delta;
      const positions = item.points.geometry.attributes.position;
      item.velocity.forEach((velocity, particle) => {
        velocity.y -= item.gravity * delta;
        positions.setXYZ(particle, positions.getX(particle) + velocity.x * delta, positions.getY(particle) + velocity.y * delta, positions.getZ(particle) + velocity.z * delta);
      });
      positions.needsUpdate = true;
      item.points.material.opacity = Math.max(0, 1 - item.age / 1.4);
      if (item.age > 1.4) { scene.remove(item.points); item.points.geometry.dispose(); bursts.splice(index, 1); }
    }
    particles.userData.tick?.(delta);
    renderer.render(scene, camera);
  });

  return {
    /** Abre o pacote; resolve quando as cartas chegaram à mesa (prontas para virar). */
    open() {
      if (reduced) { group.visible = false; cardsAt = clock.elapsedTime - 5; return Promise.resolve(); }
      openedAt = clock.elapsedTime;
      return new Promise((resolve) => { done = resolve; });
    },
    revealAll() { cards.filter((card) => card.userData.revealAt === null).forEach((card, order) => setTimeout(() => reveal(card), order * 260)); },
    /** Estado da peça do Enigma (diagnóstico). */
    pieceState: () => ({ requested: Boolean(piece), loaded: piecePivot.children.length, visible: piecePivot.visible, at: pieceAt, position: piecePivot.position.toArray().map((v) => +v.toFixed(2)), scale: +piecePivot.scale.x.toFixed(2) }),
    /** Posição de tela de uma carta (para testes e acessibilidade). */
    cardAt(index) {
      const card = cards[index];
      if (!card) return null;
      const point = card.getWorldPosition(new THREE.Vector3()).project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + (point.x + 1) / 2 * rect.width, y: rect.top + (1 - point.y) / 2 * rect.height };
    },
  };
}

/**
 * Vitrine das raridades de booster (comum, prata, ouro) lado a lado, girando devagar, num único canvas/renderer.
 * Pausa fora da tela. Devolve { destroy }.
 */
export function tierShowcase(canvas, { mark, subtitle = '', tiers = ['common', 'silver', 'gold'], reduced = false }) {
  const renderer = makeRenderer(canvas, 1.5);
  if (!renderer) return { destroy() {} };
  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffe2a8, 2.2);
  key.position.set(-3, 4, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.4); // de frente: prata e ouro (muito metálicos) ficam escuros só com o ambiente
  fill.position.set(2, 1, 8);
  scene.add(fill);
  const spacing = W * 1.25;
  const packs = tiers.map((id, index) => {
    const { group } = buildPack(renderer, { mark, subtitle, look: PACK_TIERS[id] });
    group.position.x = (index - (tiers.length - 1) / 2) * spacing;
    group.rotation.y = index * 0.5;
    scene.add(group);
    return group;
  });
  let visible = true;
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }) : null;
  observer?.observe(canvas);
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (!visible) return;
    fit(renderer, camera, canvas);
    const span = tiers.length * spacing;
    camera.position.set(0, 0, Math.max(9, (span / 2 + 0.3) / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect))); // enquadra os três na largura
    const time = clock.getElapsedTime();
    packs.forEach((group, index) => {
      if (!reduced) group.rotation.y = Math.sin(time * 0.5 + index * 0.9) * 0.7; // vai e volta devagar: o rosto fica sempre legível
      group.position.y = reduced ? 0 : Math.sin(time * 1.1 + index) * 0.06;
    });
    renderer.render(scene, camera);
  });
  return { destroy() { renderer.setAnimationLoop(null); observer?.disconnect(); renderer.dispose(); } };
}

/* ---------- Enigma do Milênio ---------- */
// Modelo real em 38 peças (tools/puzzle/build_puzzle.py), carregado de src/assets/puzzle/.

let puzzleCache = null;
function loadPuzzle(base) {
  puzzleCache ||= Promise.all([fetch(`${base}puzzle.json`).then((r) => r.json()), fetch(`${base}puzzle.bin`).then((r) => r.arrayBuffer())]).then(([meta, buffer]) => {
    const raw = new Int16Array(buffer);
    const positions = ({ start, count }) => {
      const out = new Float32Array(count * 3);
      for (let index = 0; index < count * 3; index += 1) out[index] = raw[start * 3 + index] * meta.scale;
      return out;
    };
    return { meta, pieces: meta.pieces.map((piece) => ({ ...piece, positions: positions(piece) })), ring: positions(meta.ring) };
  });
  return puzzleCache;
}

/** Junta as 38 partes do modelo em `n` peças (dias do mês): a menor se une à vizinha mais próxima. */
function groupPieces(parts, n) {
  const groups = parts.map((part) => ({ arrays: [part.positions], count: part.count, center: [...part.center] }));
  while (groups.length > n) {
    groups.sort((a, b) => a.count - b.count);
    const small = groups.shift();
    const distance = (group) => Math.hypot(...group.center.map((value, axis) => value - small.center[axis]));
    const near = groups.reduce((best, group) => (distance(group) < distance(best) ? group : best));
    near.center = near.center.map((value, axis) => (value * near.count + small.center[axis] * small.count) / (near.count + small.count));
    near.count += small.count;
    near.arrays.push(...small.arrays);
  }
  // Ordem de montagem: da ponta (dia 1) para cima.
  return groups.sort((a, b) => a.center[1] - b.center[1]);
}

function geometryOf(...arrays) {
  // Triângulos soltos de várias peças numa malha só: um draw call para o enigma inteiro.
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const array of arrays) { merged.set(array, offset); offset += array.length; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  geometry.computeVertexNormals(); // normais por face: arestas vivas
  return geometry;
}

/**
 * Ouro com profundidade: escurece o que está abaixo da superfície externa da pirâmide
 * (vincos entre peças e o olho em relevo), borda dourada pelo ângulo e um brilho que corre pelas faces.
 * A distância à superfície sai da forma analítica da pirâmide invertida: custo quase zero.
 */
function puzzleMaterial(shape) {
  const material = new THREE.MeshStandardMaterial({ color: 0xffcf5a, metalness: 0.9, roughness: 0.3, emissive: 0x2a1800, emissiveIntensity: 0.5, transparent: false });
  const uniforms = { uApex: { value: shape.apex }, uTop: { value: shape.top }, uHalf: { value: shape.half }, uTime: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\nuniform float uApex, uTop, uHalf, uTime;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float halfAt = uHalf * clamp((vObj.y - uApex) / (uTop - uApex), 0.0, 1.0);
        float depth = min(uTop - vObj.y, halfAt - max(abs(vObj.x), abs(vObj.z)));
        float cavity = smoothstep(0.004, 0.05, depth);
        diffuseColor.rgb *= mix(1.0, 0.28, cavity);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
        float glint = smoothstep(0.92, 1.0, sin((vObj.y * 1.4 + vObj.x * 0.6 - uTime * 0.7) * 3.0));
        totalEmissiveRadiance += vec3(1.0, 0.78, 0.32) * (rim * 0.32 + glint * 0.28) * (1.0 - cavity);`);
  };
  material.userData.uniforms = uniforms;
  return material;
}

/**
 * Enigma do Milênio. Modos:
 *  - normal: peças obtidas em ouro (uma malha), as que faltam em contorno; `fresh` voa até o lugar
 *  - assemble: as 38 peças entram uma a uma e a argola fecha (demonstração)
 *  - explode: o enigma completo explode em partes (ao usar o Coração das Cartas); `onDone` no fim
 */
export function puzzleScene(canvas, { owned = [], total = 38, fresh = null, reduced = false, assemble = false, explode = false, onDone = null, base = 'src/assets/puzzle/' }) {
  const renderer = makeRenderer(canvas);
  if (!renderer) { onDone?.(); return {}; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // metal + shader: 1.5x já fica nítido e alivia o celular
  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 0.8, 9);
  camera.lookAt(0, -0.1, 0);
  scene.add(new THREE.AmbientLight(0xfff1d6, 1.2));
  const key = new THREE.DirectionalLight(0xffe7b0, 4);
  key.position.set(-3, 5, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fe0c8, 1.4);
  fill.position.set(4, -1, 4);
  scene.add(fill);
  const complete = explode || owned.length >= total;
  const glow = new THREE.PointLight(GOLD, complete ? 60 : 0, 10);
  glow.position.set(0, 0, 3);
  scene.add(glow);

  const puzzle = new THREE.Group();
  scene.add(puzzle);
  const ghost = new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.3 });
  const moldFill = new THREE.MeshBasicMaterial({ color: 0x0b0906, transparent: true, opacity: 0.55 });
  const movers = []; // peças animadas: { mesh, from, to, start, spin }
  let material = null;
  let ringMesh = null;
  let ringAt = Infinity;
  let explodedAt = null;

  loadPuzzle(base).then(({ meta, pieces: parts, ring }) => {
    const pieces = groupPieces(parts, total);
    material = puzzleMaterial(meta.shape);
    const haveIt = (index) => explode || owned.includes(index);
    if (assemble || explode) {
      pieces.forEach((piece, index) => {
        const mesh = new THREE.Mesh(geometryOf(...piece.arrays), explode ? material.clone() : material);
        if (explode) { mesh.material.onBeforeCompile = material.onBeforeCompile; mesh.material.transparent = true; }
        const away = new THREE.Vector3(...piece.center).normalize().multiplyScalar(explode ? 7 + Math.random() * 3 : 4.5).add(new THREE.Vector3(0, explode ? 1 + Math.random() * 2 : 1.5, explode ? 2 + Math.random() * 3 : 3));
        if (assemble) {
          puzzle.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), ghost));
          mesh.visible = false;
        }
        puzzle.add(mesh);
        const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(explode ? 9 : 3);
        movers.push(assemble ? { mesh, from: away, to: new THREE.Vector3(), start: 0.8 + index * 0.32, spin } : { mesh, from: new THREE.Vector3(), to: away, start: 0.9 + Math.random() * 0.15, spin });
      });
      ringMesh = new THREE.Mesh(geometryOf(ring), material);
      ringMesh.visible = explode;
      puzzle.add(ringMesh);
      ringAt = assemble ? 0.8 + pieces.length * 0.32 + 0.6 : Infinity;
      if (explode) movers.push({ mesh: ringMesh, from: new THREE.Vector3(), to: new THREE.Vector3(0, 6, 2), start: 0.9, spin: new THREE.Vector3(4, 2, 0) });
      return;
    }
    // Estático: tudo que o jogador tem vira uma malha só; o que falta, contorno.
    const placed = pieces.filter((_, index) => haveIt(index) && index !== fresh).flatMap((piece) => piece.arrays);
    if (complete) placed.push(ring);
    if (placed.length) puzzle.add(new THREE.Mesh(geometryOf(...placed), material));
    // Molde vazio: preenchimento escuro + contorno dourado fino (a peça nova encaixa aqui).
    const molds = pieces.filter((_, index) => !haveIt(index) || index === fresh);
    if (molds.length) {
      const hollow = geometryOf(...molds.flatMap((piece) => piece.arrays));
      puzzle.add(new THREE.Mesh(hollow, moldFill));
      puzzle.add(new THREE.LineSegments(new THREE.EdgesGeometry(hollow, 25), ghost));
    }
    if (fresh !== null && haveIt(fresh)) {
      const mesh = new THREE.Mesh(geometryOf(...pieces[fresh].arrays), material);
      puzzle.add(mesh);
      const from = new THREE.Vector3(...pieces[fresh].center).normalize().multiplyScalar(5).add(new THREE.Vector3(0, 2, 3));
      if (reduced) movers.length = 0; else { mesh.position.copy(from); movers.push({ mesh, from, to: new THREE.Vector3(), start: 0.8, spin: new THREE.Vector3(1, 2, 0) }); }
    }
  });

  const halo = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.015, 8, 140), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: complete ? 0.7 : 0.2 }));
  halo.rotation.x = Math.PI / 2;
  halo.position.y = -0.3;
  scene.add(halo);
  const particles = dust(reduced ? 0 : explode ? 300 : 120, { x: 9, y: 7, z: 5 });
  scene.add(particles);

  const target = new THREE.Vector2();
  const onMove = (event) => {
    const rect = canvas.getBoundingClientRect();
    target.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  };
  addEventListener('pointermove', onMove, { passive: true });
  const clock = new THREE.Clock();
  let finished = false;
  renderer.setAnimationLoop(() => {
    fit(renderer, camera, canvas);
    // Tela em pé (Coração das Cartas no celular): afasta a câmera para o Enigma caber na largura.
    camera.position.z = 9 * Math.max(1, 0.9 / camera.aspect) ** 1.3;
    camera.lookAt(0, -0.1, 0);
    const delta = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    if (material) material.userData.uniforms.uTime.value = time;
    puzzle.rotation.y = (reduced ? 0.4 : time * (explode ? 0.9 : 0.3)) + target.x * 0.5;
    puzzle.rotation.x = 0.1 - target.y * 0.15;
    for (const mover of movers) {
      const t = (time - mover.start) / (explode ? 1.1 : 0.6);
      if (t < 0) continue;
      mover.mesh.visible = true;
      const e = explode ? Math.min(1, t) ** 1.6 : 1 - (1 - Math.min(1, t)) ** 3;
      mover.mesh.position.lerpVectors(mover.from, mover.to, e);
      const spin = explode ? e : 1 - e;
      mover.mesh.rotation.set(mover.spin.x * spin, mover.spin.y * spin, mover.spin.z * spin);
      if (explode) {
        mover.mesh.material.opacity = 1 - Math.max(0, (t - 0.45) / 0.55);
        if (explodedAt === null) { explodedAt = time; glow.intensity = 320; }
      } else if (t >= 1 && !mover.done) { mover.done = true; glow.intensity = Math.max(glow.intensity, 60); }
    }
    if (assemble && ringMesh && time > ringAt && !ringMesh.visible) { ringMesh.visible = true; glow.intensity = 220; halo.material.opacity = 0.75; }
    if (explode && explodedAt !== null) halo.material.opacity = Math.max(0, 0.7 - (time - explodedAt) * 0.6);
    const lit = (complete && !explode) || ringMesh?.visible;
    glow.intensity += ((lit ? 60 + Math.sin(time * 2) * 20 : 0) - glow.intensity) * (explode ? 0.02 : 0.04);
    halo.rotation.z = time * 0.2;
    if (!reduced) ghost.opacity = 0.26 + Math.sin(time * 1.4) * 0.12; // pulso lento do molde vazio
    particles.userData.tick?.(delta);
    renderer.render(scene, camera);
    if (explode && !finished && explodedAt !== null && time - explodedAt > 1.9) {
      finished = true;
      onDone?.();
    }
  });
  return {
    dispose() {
      renderer.setAnimationLoop(null);
      removeEventListener('pointermove', onMove);
      renderer.dispose();
    },
  };
}

/* ---------- Enigma do Milênio procedural (Coração das Cartas na arena) ---------- */
// Pirâmide de base quadrada com a ponta para baixo, cortada em fatias e quadrantes (as peças que se separam ao ativar),
// em ouro metálico, com o Olho de Wdjat gravado na face da frente (cor e relevo desenhados em canvas) e a argola no topo.
// Reserva do modelo da aba Enigma (src/assets/puzzle, do setup): aparece enquanto ele carrega ou quando ele não existe.
const ENIGMA = { half: 1, top: 0.55, apex: -1.45, depth: 0.86, cuts: [0.55, 0.02, -0.45, -0.88, -1.45] };

/** Face da frente: ouro com o olho. tone: cores (textura) ou cinzas (relevo: escuro = gravado). */
function wdjatCanvas(tone) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (tone.background) {
    const fill = context.createLinearGradient(0, 0, size * 0.3, size);
    tone.background.forEach((color, index) => fill.addColorStop(index / (tone.background.length - 1), color));
    context.fillStyle = fill;
  } else context.fillStyle = tone.flat;
  context.fillRect(0, 0, size, size);
  // Emendas das peças desenhadas de leve (as fatias reais já abrem frestas)
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = tone.line;
  context.lineWidth = 13;
  context.beginPath(); // sobrancelha
  context.moveTo(140, 92);
  context.quadraticCurveTo(256, 24, 372, 88);
  context.stroke();
  context.beginPath(); // pálpebras (amêndoa)
  context.moveTo(136, 152);
  context.quadraticCurveTo(256, 62, 376, 152);
  context.quadraticCurveTo(256, 222, 136, 152);
  context.closePath();
  context.fillStyle = tone.lid;
  context.fill();
  context.stroke();
  context.beginPath(); // íris
  context.arc(256, 146, 34, 0, Math.PI * 2);
  context.fillStyle = tone.iris;
  context.fill();
  context.lineWidth = 10;
  context.stroke();
  context.beginPath(); // pupila
  context.arc(256, 146, 12, 0, Math.PI * 2);
  context.fillStyle = tone.line;
  context.fill();
  context.lineWidth = 13;
  context.beginPath(); // a lágrima em espiral e a perna reta do Wdjat
  context.moveTo(226, 198);
  context.quadraticCurveTo(214, 262, 160, 268);
  context.quadraticCurveTo(138, 266, 146, 246);
  context.moveTo(288, 200);
  context.lineTo(330, 276);
  context.quadraticCurveTo(334, 296, 312, 298);
  context.stroke();
  return canvas;
}

function enigmaMaterials() {
  const map = new THREE.CanvasTexture(wdjatCanvas({ background: ['#ffe28e', '#f0b334', '#c27f12', '#7e4806'], line: '#3a2104', lid: '#6d3d07', iris: '#ffe596' }));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(wdjatCanvas({ flat: '#9a9a9a', line: '#101010', lid: '#3c3c3c', iris: '#d8d8d8' }));
  const gold = new THREE.MeshStandardMaterial({ color: 0xf6c04a, metalness: 0.9, roughness: 0.26, emissive: 0x5a3400, emissiveIntensity: 0.5, side: THREE.DoubleSide });
  const face = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 4, metalness: 0.62, roughness: 0.34, emissive: 0x5a3400, emissiveIntensity: 0.5, side: THREE.DoubleSide });
  return [gold, face];
}

/** As peças: fatias horizontais divididas em quatro quadrantes, cada uma com a face da frente (grupo 1) mapeada no olho. */
function buildEnigma() {
  const { half, top, apex, depth, cuts } = ENIGMA;
  const width = (y) => half * (y - apex) / (top - apex);
  const materials = enigmaMaterials();
  const group = new THREE.Group();
  const pieces = [];
  for (let layer = 0; layer < cuts.length - 1; layer += 1) {
    const [y0, y1] = [cuts[layer], cuts[layer + 1]];
    const [s0, s1] = [width(y0), width(y1)];
    // Nas fatias do olho a frente fica inteira (sem emenda vertical cortando o olho); a ponta se divide em quadrantes.
    const whole = layer < cuts.length - 2;
    for (const [sx, sz] of whole ? [[1, 1], [1, -1]] : [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      const x0 = whole ? -1 : 0;
      const a = [[x0 * s0, y0, 0], [sx * s0, y0, 0], [sx * s0, y0, sz * s0 * depth], [x0 * s0, y0, sz * s0 * depth]];
      const b = [[x0 * s1, y1, 0], [sx * s1, y1, 0], [sx * s1, y1, sz * s1 * depth], [x0 * s1, y1, sz * s1 * depth]];
      const quads = [[a[0], a[1], a[2], a[3]], [b[0], b[3], b[2], b[1]], [a[0], a[3], b[3], b[0]], [a[0], b[0], b[1], a[1]], [a[1], b[1], b[2], a[2]], [a[3], a[2], b[2], b[3]]];
      const center = [...a, ...b].reduce((sum, p) => sum.add(new THREE.Vector3(...p)), new THREE.Vector3()).multiplyScalar(1 / 8);
      const positions = [];
      const uvs = [];
      const geometry = new THREE.BufferGeometry();
      quads.forEach((quad, index) => {
        for (const p of [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]]) {
          // Fresta entre as peças: cada uma encolhe um pouco para o próprio centro.
          const v = new THREE.Vector3(...p).sub(center).multiplyScalar(0.965);
          positions.push(v.x, v.y, v.z);
          uvs.push((p[0] / half + 1) / 2, (p[1] - apex) / (top - apex));
        }
        geometry.addGroup(index * 6, 6, index === 5 && sz > 0 ? 1 : 0);
      });
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.position.copy(center);
      group.add(mesh);
      pieces.push({ mesh, home: center.clone(), dir: center.clone().setY(center.y + 0.35).normalize().add(new THREE.Vector3(0, 0, 0.5)).normalize() });
    }
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.055, 12, 36), materials[0]);
  ring.position.set(0, top + 0.24, 0);
  group.add(ring);
  pieces.push({ mesh: ring, home: ring.position.clone(), dir: new THREE.Vector3(0, 1, 0.3).normalize() });
  return {
    group, pieces, materials,
    dispose() { group.traverse((node) => node.geometry?.dispose()); for (const material of materials) { material.map?.dispose(); material.bumpMap?.dispose(); material.dispose(); } },
  };
}

/**
 * O Enigma da aba Enigma (modelo do setup, as mesmas peças e o mesmo ouro), no tamanho e na posição da pirâmide
 * procedural para caber nos mesmos enquadramentos. Cada parte gira em torno do próprio centro; a geometria
 * continua nas coordenadas do modelo porque o shader do ouro usa a posição original.
 */
let puzzleData = null; // o modelo já carregado: a ativação monta o Enigma real sem esperar
function realEnigma({ meta, pieces: parts, ring }) {
  const material = puzzleMaterial(meta.shape);
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const pieces = [...parts.map((part) => part.positions), ring].map((positions) => {
    const geometry = geometryOf(positions);
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    const holder = new THREE.Group();
    holder.position.copy(center);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(center).negate();
    holder.add(mesh);
    model.add(holder);
    return { mesh: holder, home: center.clone(), dir: center.clone().setY(center.y + 0.35).normalize().add(new THREE.Vector3(0, 0, 0.5)).normalize() };
  });
  // Mesma altura (ponta à argola) e mesmo centro da procedural.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = (ENIGMA.top + 0.485 - ENIGMA.apex) / size.y;
  model.scale.setScalar(scale);
  model.position.y = (ENIGMA.top + 0.485 + ENIGMA.apex) / 2 - box.getCenter(new THREE.Vector3()).y * scale;
  return {
    group, pieces, materials: [material], unit: 1 / scale,
    tick(time) { material.userData.uniforms.uTime.value = time; },
    dispose() { model.traverse((node) => node.geometry?.dispose()); material.dispose(); },
  };
}

function enigmaStage(renderer) {
  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  scene.add(new THREE.HemisphereLight(0xfff1d0, 0x2a1d0c, 1.7));
  const key = new THREE.DirectionalLight(0xffe2a0, 4.2);
  key.position.set(-2.5, 3, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fe0c8, 0.9);
  fill.position.set(3, -1, 3);
  scene.add(fill);
  return scene;
}

/** Miniatura viva (botão do Coração das Cartas): balança devagar mostrando o olho; parada com reduced. null sem WebGL. */
export function enigmaMini(canvas, { reduced = false } = {}) {
  const renderer = makeRenderer(canvas, 2);
  if (!renderer) return null;
  const scene = enigmaStage(renderer);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0.5, 5.8);
  camera.lookAt(0, -0.3, 0);
  // A procedural aparece na hora; o modelo da aba Enigma entra no lugar dela assim que carrega (sem ele, fica a procedural).
  let enigma = puzzleData ? realEnigma(puzzleData) : buildEnigma();
  scene.add(enigma.group);
  let disposed = false;
  if (!puzzleData) {
    loadPuzzle('src/assets/puzzle/').then((data) => {
      puzzleData = data;
      if (disposed) return;
      scene.remove(enigma.group);
      enigma.dispose();
      enigma = realEnigma(data);
      scene.add(enigma.group);
    }).catch(() => {});
  }
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    fit(renderer, camera, canvas);
    const time = clock.getElapsedTime();
    enigma.tick?.(time);
    enigma.group.rotation.y = reduced ? -0.42 : Math.sin(time * 0.7) * 0.62;
    enigma.group.position.y = reduced ? 0 : Math.sin(time * 1.4) * 0.04;
    renderer.render(scene, camera);
  });
  return {
    angle: () => enigma.group.rotation.y,
    dispose() { disposed = true; renderer.setAnimationLoop(null); enigma.dispose(); renderer.dispose(); },
  };
}

/**
 * Ativação em tela cheia: a miniatura (em `from`, retângulo na tela) cresce até o centro (560 ms), brilha (480 ms)
 * e se desfaz nas peças (720 ms); onGlow avisa o começo do brilho e onDone, o fim. null sem WebGL.
 */
export function enigmaBurst(canvas, { from, angle = 0, onGlow = null, onDone = null }) {
  const renderer = makeRenderer(canvas, 1.5);
  if (!renderer) return null;
  const scene = enigmaStage(renderer);
  const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 60);
  camera.position.set(0, 0, 10);
  const glow = new THREE.PointLight(GOLD, 0, 12);
  glow.position.set(0, 0, 3);
  scene.add(glow);
  const enigma = puzzleData ? realEnigma(puzzleData) : buildEnigma();
  const pivot = new THREE.Group(); // o centro visual da pirâmide (sem a argola) fica no ponto da tela
  enigma.group.position.y = 0.42;
  pivot.add(enigma.group);
  scene.add(pivot);
  const unit = (2 * 10 * Math.tan(THREE.MathUtils.degToRad(15))) / innerHeight; // mundo por pixel no plano z = 0
  const start = new THREE.Vector3((from.left + from.width / 2 - innerWidth / 2) * unit, -(from.top + from.height / 2 - innerHeight / 2) * unit, 0);
  const tall = 2.3; // altura da peça inteira (ponta à argola), em unidades
  const scale0 = (from.height * 0.86 * unit) / tall;
  const scale1 = (Math.min(innerWidth, innerHeight) * 0.46 * unit) / tall;
  const spins = enigma.pieces.map(() => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(5));
  const drifts = enigma.pieces.map(({ dir }) => dir.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.6, 0, Math.random() * 0.5)).normalize()); // abre para os lados também
  const reach = scale1 * 1.7;
  const began = performance.now();
  let glowing = false;
  let done = false;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  renderer.setAnimationLoop(() => {
    fit(renderer, camera, canvas);
    camera.aspect = canvas.clientWidth / canvas.clientHeight || camera.aspect;
    camera.updateProjectionMatrix();
    const ms = performance.now() - began;
    enigma.tick?.(ms / 1000);
    const grow = ease(Math.min(1, ms / 560));
    pivot.position.lerpVectors(start, new THREE.Vector3(), grow);
    const shine = Math.min(1, Math.max(0, (ms - 560) / 480));
    pivot.scale.setScalar(THREE.MathUtils.lerp(scale0, scale1, grow) * (1 + Math.sin(shine * Math.PI) * 0.08));
    pivot.rotation.y = THREE.MathUtils.lerp(angle, Math.PI * 2, grow) + (ms > 560 ? Math.sin(ms / 140) * 0.05 * (1 - shine) : 0);
    if (ms > 560 && !glowing) { glowing = true; onGlow?.(); }
    for (const material of enigma.materials) material.emissiveIntensity = 0.5 + Math.sin(Math.min(1, shine * 1.3) * Math.PI / 2) * 2.4;
    glow.intensity = shine * 90;
    const part = Math.min(1, Math.max(0, (ms - 1040) / 720));
    if (part > 0) {
      for (const material of enigma.materials) {
        if (!material.transparent) { material.transparent = true; material.needsUpdate = true; } // o ouro do modelo nasce opaco
        material.opacity = 1 - part ** 1.4;
      }
      const e = 1 - (1 - part) ** 2;
      enigma.pieces.forEach(({ mesh, home }, index) => {
        mesh.position.copy(home).addScaledVector(drifts[index], (e * reach * (enigma.unit || 1)) / pivot.scale.x);
        mesh.rotation.set(spins[index].x * e, spins[index].y * e, spins[index].z * e);
      });
      glow.intensity = 90 * (1 - part);
    }
    renderer.render(scene, camera);
    if (part >= 1 && !done) { done = true; onDone?.(); }
  });
  return { dispose() { renderer.setAnimationLoop(null); enigma.dispose(); renderer.dispose(); } };
}
