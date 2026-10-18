import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { parseSeq } from './seq.js';
import { ParticleNode } from './particles.js';
import { parseScn } from './scn.js';
import { assembleFull, mergeClips, resolveBoneWorlds, nodeResolver, mat4Mul, mat4InvAffine } from './scnSkin.js';
import { buildScene, buildCharacter, extentOf, disposeGroup, quadFrame } from './scnRender.js';
import { buildMapScene, nodeMatrixOf, yawPlace, TICKS_PER_MS } from './mapScene.js';
import { buildWeaponScene } from './weaponScene.js';

const $ = s => document.querySelector(s);
const wrap = $('#canvasWrap');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e13);
// The client draws in D3D's left-handed space and three.js is right-handed:
// every scene, effect and character hangs from this root mirrored on Z, or
// they came out mirrored (crystal plasma's blade lettering read backwards).
const world = new THREE.Group();
world.scale.z = -1;
scene.add(world);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000);
camera.position.set(0, 70, 210);

const controls = new OrbitControls(camera, renderer.domElement);
renderer.domElement.addEventListener('pointerdown', ev => { if (ev.button === 0) pickBone(ev); });
window.addEventListener('keydown', ev => {
  if (!pickedBone || ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  const k = ev.key.toLowerCase();
  if (k === 'g') setGizmoMode('translate');
  else if (k === 'r') setGizmoMode('rotate');
  else if (k === 's') setGizmoMode('scale');
  else if (k === 'escape') { tcontrol && tcontrol.detach(); pickedBone = null; syncBoneMarkers(); }
});
controls.enableDamping = true;
controls.target.set(0, 30, 0);

// Left drag looks around from where the camera is: the eye stays put and the
// view turns (WASD / R F move it). The middle button orbits the target, the
// right one pans, the wheel moves in and out. A drag that starts on a gizmo
// axis belongs to the gizmo.
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
let lookDrag = null;
renderer.domElement.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 || (tcontrol && (tcontrol.dragging || tcontrol.axis))) return;
  lookDrag = { x: ev.clientX, y: ev.clientY };
});
window.addEventListener('pointermove', ev => {
  if (!lookDrag) return;
  if (tcontrol && tcontrol.dragging) { lookDrag = null; return; }
  const dx = ev.clientX - lookDrag.x, dy = ev.clientY - lookDrag.y;
  lookDrag.x = ev.clientX; lookDrag.y = ev.clientY;
  const view = new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(controls.target, camera.position));
  view.theta -= dx * 0.005;
  view.phi = THREE.MathUtils.clamp(view.phi + dy * 0.005, 0.02, Math.PI - 0.02);
  controls.target.copy(camera.position).add(new THREE.Vector3().setFromSpherical(view));
});
window.addEventListener('pointerup', ev => { if (ev.button === 0) lookDrag = null; });

let grid = new THREE.GridHelper(400, 20, 0x2a3442, 0x1a2028);
scene.add(grid);

let sysNodes = [];
let current = null;
let playing = true;
let tMs = 0;
let tAbs = 0;          // unwrapped playback clock (continuous emitters)
const flyKeys = new Set();   // free camera: W A S D (plane), R F (up / down), Shift = faster
let last = performance.now();
let lastExtent = 100;
let lastFull = 100;
let boost = 1;
let cameraPlaced = false;
let autoFit = false;

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  for (const s of sysNodes) s.setPixelScale(pixelScale());
}
new ResizeObserver(resize).observe(wrap);
resize();

const ddsLoader = new DDSLoader();

// DXT data is stored in 4x4 blocks: a w x h level takes ceil(w/4) x ceil(h/4)
// of them. DDSLoader counts max(4, w) / 4, a fraction when w is not a multiple
// of 4 (the 6x6 level of a 1536 chain, 498-wide effect textures), so every
// later level was read from the wrong place and WebGL refused the whole
// texture (goal_arrow2_atex: the goal arrows drew black).
const BLOCK_BYTES = {
  [THREE.RGB_S3TC_DXT1_Format]: 8, [THREE.RGBA_S3TC_DXT1_Format]: 8,
  [THREE.RGBA_S3TC_DXT3_Format]: 16, [THREE.RGBA_S3TC_DXT5_Format]: 16, [THREE.RGB_ETC1_Format]: 8,
};
function fixBlockMips(d, buf) {
  const bs = BLOCK_BYTES[d.format];
  if (!bs) return;
  let offset = d.mipmaps[0].data.byteOffset;
  for (let i = 0; i < d.mipmaps.length; i++) {
    const m = d.mipmaps[i];
    const size = Math.ceil(m.width / 4) * Math.ceil(m.height / 4) * bs;
    if (offset + size > buf.byteLength) { d.mipmaps.length = Math.max(1, i); break; }   // short file: keep the whole levels
    m.data = new Uint8Array(buf, offset, size);
    offset += size;
  }
}
const tgaLoader = new TGALoader();
const texLoader = new THREE.TextureLoader();
const texCache = new Map();

function sniff(buf) {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  const s = String.fromCharCode(...b);
  if (s.startsWith('DDS ')) return 'dds';
  if (b[0] === 0x89 && s.slice(1, 4) === 'PNG') return 'png';
  if (s.startsWith('BM')) return 'bmp';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  return 'tga';
}

async function textureFromBuffer(buf) {
  const type = sniff(buf);

  if (type === 'dds') {
    const d = ddsLoader.parse(buf, true);
    if (!d || !d.mipmaps?.length) return null;
    fixBlockMips(d, buf);
    const t = new THREE.CompressedTexture(d.mipmaps, d.width, d.height, d.format);
    if (d.mipmaps.length === 1) t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }

  if (type === 'tga') {
    const d = tgaLoader.parse(buf);
    if (!d || !d.data) return null;
    const t = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat);
    t.flipY = false;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  const bmp = await createImageBitmap(new Blob([buf]));
  const t = new THREE.Texture(bmp);
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

function loadTexture(file) {
  if (texCache.has(file)) return texCache.get(file);
  const p = (async () => {
    try {
      const r = await fetch('/res/' + encodeURIComponent(file));
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const t = await textureFromBuffer(buf);
      if (t) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        if (t.wrapS !== THREE.RepeatWrapping) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      }
      return t;
    } catch {
      return null;
    }
  })();
  texCache.set(file, p);
  return p;
}

let seqScnGroup = null;
let scnGroup = null;
let scnFile = null, scnData = null, scnPlayback = null, scnTimer = 0, pbTimer = 0, scnParsed = null;
// declared up here on purpose: frame() runs while this module is still being
// evaluated, and it calls syncBoneMarkers() before the gizmo block below.
let boneMarkers = null, tcontrol = null, pickedBone = null;
const rayc = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let charaGroup = null;
let sceneAnimators = [];
let clipIdx = 0;
// Map preview (?map=): the bginfo map's scenes under one root mirrored on Z
// (the client's left-handed space shown right-handed), the sky drawn around
// the eye, the [ADDON_SEQUENCE] effects on their nodes, one map clock.
let mapRoot = null, mapSky = null, mapScenes = [], mapEffects = [], mapClock = 0;
// Weapon preview (?weapon=<file>&fx=[{node, file}]): that .scn drawn as the
// game draws a weapon, with its weapon-table <sequence> effects on its nodes.
const weaponQuery = new URLSearchParams(location.search);
const weaponParam = (weaponQuery.get('weapon') || '').toLowerCase();
let weaponFx = [];
try { weaponFx = JSON.parse(weaponQuery.get('fx') || '[]'); } catch {}
let weaponBuilt = null, weaponEffects = [];
// A scene's item <sequence> effects (a pet's aura, a costume piece's glow),
// each on a node of the scene; placed from its node resolver every frame.
let scnEffects = [], scnWorldOfAt = null, scnClips = [];

function allClips() { const s = new Set(); for (const a of sceneAnimators) for (const c of a.clips) s.add(c); return [...s]; }
function updateAnimHud() {
  const el = document.getElementById('animhud'); if (!el) return;
  const clips = allClips();
  el.textContent = clips.length ? `anim: ${clips[clipIdx % clips.length]}  (${(clipIdx % clips.length) + 1}/${clips.length})  ·  Q/E cycles` : '';
  el.style.display = clips.length ? 'block' : 'none';
}

function clearNodes() {
  for (const s of sysNodes) { s.points.removeFromParent(); s.dispose(); }
  sysNodes = [];
  for (const g of [seqScnGroup, scnGroup]) {
    if (g) { g.removeFromParent(); disposeGroup(g); }
  }
  seqScnGroup = scnGroup = null;
  sceneAnimators = [];
  clipIdx = 0;
  updateAnimHud();
  if (mapRoot) {
    mapRoot.removeFromParent();
    for (const s of mapScenes) s.dispose();
  }
  for (const fx of [...mapEffects, ...weaponEffects, ...scnEffects]) for (const md of fx.models) disposeGroup(md.group);
  if (weaponBuilt) { weaponBuilt.group.removeFromParent(); weaponBuilt.dispose(); }
  mapRoot = mapSky = weaponBuilt = null;
  mapScenes = []; mapEffects = []; weaponEffects = [];
  scnEffects = []; scnWorldOfAt = null; scnClips = [];
  grid.visible = true;
}

window.addEventListener('keydown', e => {
  const clips = allClips();
  if (!clips.length) return;
  if (e.key.toLowerCase() === 'e') { clipIdx = (clipIdx + 1) % clips.length; updateAnimHud(); }
  else if (e.key.toLowerCase() === 'q') { clipIdx = (clipIdx - 1 + clips.length) % clips.length; updateAnimHud(); }
});

async function loadScn(file) {
  const r = await fetch('/res/' + encodeURIComponent(file));
  if (!r.ok) throw new Error(`could not read ${file} (${r.status})`);
  return parseScn(await r.arrayBuffer());
}

async function openScn(file) {
  if (weaponParam && file.toLowerCase() === weaponParam) return openWeapon(file);
  clearNodes();
  current = null;
  scnFile = file;
  const scn = await loadScn(file);
  scnParsed = scn;
  scn.sharedSpace = new URLSearchParams(location.search).get('shared') === '1';
  const { group, stats, animate, worldOfAt, clips, duration } = await buildScene(scn, f => loadTexture(f));
  scnGroup = group;
  sceneAnimators = animate ? [{ animate, clips: clips || [] }] : [];
  scnDuration = duration || 0;
  clipIdx = 0; updateAnimHud();
  world.add(group);

  // The item's <sequence> effects (item table: pets, costume pieces), each
  // hung from a node of the scene as the game does (a pet's aura on its
  // dummy). The main app passes them with the scene (?fx=).
  scnWorldOfAt = worldOfAt || null;
  scnClips = clips || [];
  const fxFailed = [];
  for (const fx of weaponFx) {
    try {
      const e = await buildEffect(fx.file, '');
      e.node = fx.node;
      group.add(e.group);
      scnEffects.push(e);
    } catch (e) { fxFailed.push(`${fx.file}: ${e.message}`); }
  }

  let radius, center, floorY = null;
  {
    const box = new THREE.Box3(), v = new THREE.Vector3();
    const clip = clips && clips.length ? clips[0] : '';
    const sweep = () => { for (const o of group.children) { const p = o.geometry.attributes.position.array; for (let i = 0; i + 2 < p.length; i += 3) box.expandByPoint(v.set(p[i], p[i + 1], -p[i + 2])); } };
    if (animate && duration > 0) { for (let i = 0; i <= 12; i++) { animate(duration * i / 12, clip); sweep(); } animate(0, clip); }
    else sweep();
    if (!box.isEmpty()) { const s = box.getBoundingSphere(new THREE.Sphere()); if (isFinite(s.radius) && s.radius > 0) { radius = Math.max(1, s.radius); center = s.center; floorY = box.min.y; } }
  }
  if (radius == null) { const e = extentOf(group); radius = e.radius; center = e.center; }
  radius *= 1.6;
  lastExtent = radius; lastFull = radius;
  if (!cameraPlaced || autoFit) { fitCamera(radius, radius, center, floorY); cameraPlaced = true; }
  buildBoneMarkers(scn, radius);

  $('#hud').innerHTML = `<b>${file}</b><br>` +
    `${stats.meshes} meshes · ${Math.round(stats.tris)} triangles · ` +
    `${scn.bones.length} bones · ${scn.animNames.length} clips · ` +
    `${stats.textures} textures` +
    (weaponFx.length ? ` · ${scnEffects.length}/${weaponFx.length} effects` : '') +
    (stats.untextured ? ` · <span style="color:#ff64c8">${stats.untextured} untextured</span>` : '');

  $('#info').innerHTML = scnEffects.map(fx => `
    <div class="node">
      <div><span class="cls">${esc(fx.file)}</span> <span class="nm">on ${esc(fx.node)}</span></div>
      <div class="kv">particle nodes <b>${fx.systems.length}</b> · models <b>${fx.models.length}</b> · ${fx.duration} ms loop</div>
    </div>`).join('') +
    (fxFailed.length ? `<div class="node">${fxFailed.map(t => `<div class="asset missing">⚠ ${esc(t)}</div>`).join('')}</div>` : '') + `
    <div class="node">
      <div class="kv">version <b>${scn.version}</b></div>
      <div class="kv">models <b>${scn.models.length}</b> · with geometry <b>${scn.meshes.length}</b></div>
      <div class="kv">bones <b>${scn.bones.length}</b> · clips <b>${scn.animNames.length}</b></div>
    </div>` + scn.meshes.slice(0, 60).map(m => `
    <div class="node">
      <div><span class="cls">${m.name || '(unnamed)'}</span></div>
      <div class="kv">verts <b>${m.positions.length / 3}</b> · tris <b>${m.indices.length / 3}</b>
           · skin <b>${m.skin.length}</b> · flags <b>${m.renderFlag}</b></div>
      ${m.texItems.filter(t => t.name).map(t => `<div class="asset">${t.name}</div>`).join('')}
    </div>`).join('') +
    (scn.animNames.length ? `<div class="node"><div class="kv">clips: ${scn.animNames.slice(0, 30).join(', ')}</div></div>` : '');
}

const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A whole map as the client loads it from its bginfo: the manifest lists the
// scenes ([SKY], [STATIC], [DYNAMIC]; occlusion scenes are never drawn) and the
// effects ([ADDON_SEQUENCE] seq + the node it plays on).
async function openMap(file) {
  clearNodes();
  current = null;
  scnFile = null; scnPlayback = null; scnData = null; scnParsed = null; clearBoneMarkers();
  const r = await fetch('/res/' + encodeURIComponent(file));
  if (!r.ok) throw new Error(`could not read ${file} (${r.status})`);
  const man = await r.json();

  mapRoot = new THREE.Group();
  world.add(mapRoot);
  mapClock = 0;
  const totals = { meshes: 0, tris: 0, textures: 0, untextured: 0, lightmaps: 0 };
  const failed = [];
  for (let i = 0; i < man.scenes.length; i++) {
    const s = man.scenes[i];
    const sky = s.kind === 'sky';
    try {
      const scn = await loadScn('map/' + s.file);
      const built = await buildMapScene(scn, f => loadTexture('map/' + f), { sky, renderBase: sky ? -1e7 : i * 100000 });
      Object.assign(built, { scn, file: s.file, kind: s.kind, sky });
      if (sky) {
        // The sky dome is drawn around the eye, scaled inside the far plane.
        mapSky = new THREE.Group();
        mapSky.scale.setScalar(0.1);
        mapSky.add(built.group);
        mapRoot.add(mapSky);
      } else {
        mapRoot.add(built.group);
      }
      mapScenes.push(built);
      for (const k in totals) totals[k] += built.stats[k];
    } catch (e) {
      failed.push(`${s.file}: ${e.message}`);
    }
  }

  for (const fx of man.seqs) {
    let M = null;
    for (const s of mapScenes) { M = nodeMatrixOf(s.scn, fx.dummy); if (M) break; }
    if (!M && fx.dummy) { failed.push(`${fx.file}: node ${fx.dummy} is not in the map`); continue; }
    try {
      const e = await buildEffect(fx.file);
      e.group.matrix.fromArray(yawPlace(M || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
      mapRoot.add(e.group);
      mapEffects.push(e);
    } catch (e) { failed.push(`${fx.file}: ${e.message}`); }
  }

  fitMap();
  const missing = man.missing || [];
  $('#hud').innerHTML = `<b>${esc(man.ini)}</b>${man.name ? ' · ' + esc(man.name) : ''}<br>` +
    `${mapScenes.length}/${man.scenes.length} scenes · ${totals.meshes} meshes · ${Math.round(totals.tris)} triangles · ` +
    `${totals.textures} textures · ${totals.lightmaps} lightmapped · ${mapEffects.length}/${man.seqs.length} effects` +
    (totals.untextured ? ` · <span style="color:#ff64c8">${totals.untextured} untextured</span>` : '') +
    (missing.length ? ` · <span style="color:#ff64c8">${missing.length} missing files</span>` : '');
  $('#info').innerHTML = `
    <div class="node">
      <div class="kv">map <b>${esc(man.ini)}</b>${man.name ? ' · ' + esc(man.name) : ''}</div>
      <div class="kv">WASD / R F move · Shift faster · left drag looks around · middle orbits · right pans</div>
    </div>` + mapScenes.map(s => `
    <div class="node">
      <div><span class="cls">${esc(s.file)}</span> <span class="nm">${esc(s.kind)}</span></div>
      <div class="kv">meshes <b>${s.stats.meshes}</b> · tris <b>${Math.round(s.stats.tris)}</b> · lightmapped <b>${s.stats.lightmaps}</b>${s.clip ? ` · clip <b>${esc(s.clip)}</b>` : ''}</div>
    </div>`).join('') + mapEffects.map(fx => `
    <div class="node">
      <div><span class="cls">${esc(fx.file)}</span> <span class="nm">effect</span></div>
      <div class="kv">particle nodes <b>${fx.systems.length}</b> · models <b>${fx.models.length}</b> · ${fx.duration} ms loop</div>
    </div>`).join('') +
    (failed.length || missing.length ? `<div class="node">${[...failed, ...missing.map(m => 'missing: ' + m)].map(t => `<div class="asset missing">⚠ ${esc(t)}</div>`).join('')}</div>` : '');
}

// One effect sequence (a map's [ADDON_SEQUENCE], a weapon's <sequence>): its
// particle nodes and models under one group the caller places. `dir`: the
// preview folder its files were written to.
async function buildEffect(file, dir = 'effects/') {
  const r = await fetch('/res/' + encodeURIComponent(dir + file));
  if (!r.ok) throw new Error(`could not read (${r.status})`);
  const seq = parseSeq(await r.arrayBuffer());
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const systems = [];
  for (const n of seq.nodes.filter(x => x.emitters !== undefined)) {
    const tex = n.textures?.[0] ? await loadTexture(dir + n.textures[0].file) : null;
    const sys = new ParticleNode(n, tex, 1);
    sys.setPixelScale(pixelScale() * boost);
    group.add(sys.points);
    sysNodes.push(sys);   // resize and the size slider reach it; cleared with the rest
    systems.push(sys);
  }
  const models = [];
  const refs = new Set(seq.nodes.flatMap(n => (n.assets || []).filter(a => a.ext === 'scn').map(a => a.file)));
  for (const f of refs) {
    try {
      const built = await buildScene(await loadScn(dir + f), t => loadTexture(dir + t));
      group.add(built.group);
      models.push(built);
    } catch {}
  }
  return { file, group, systems, models, duration: seq.duration || 0 };
}

// Effects restart at every pass of their sequence; their models play the
// scene clip at 4.8 ticks per ms and the particle nodes named after a model
// node emit from it. steady: an equipped item's effect (weapon / costume
// <sequence>) keeps its continuous emitters running across the restart.
function updateEffects(list, ms, steady = false) {
  for (const fx of list) {
    const age = fx.duration > 0 ? ms % fx.duration : ms;
    const tick = age * TICKS_PER_MS;
    for (const md of fx.models) if (md.animate) md.animate(tick, md.clips[0] || '');
    for (const s of fx.systems) {
      if (s.nodeName) {
        for (const md of fx.models) {
          const w = md.worldOfAt(tick, md.clips[0] || '')(s.nodeName);
          if (!w) continue;
          s.points.matrixAutoUpdate = false;
          s.points.matrix.fromArray(w);
          s.setNodeScale(Math.max(Math.hypot(w[0], w[1], w[2]), Math.hypot(w[4], w[5], w[6]), Math.hypot(w[8], w[9], w[10])));
          break;
        }
      }
      s.update(age, steady ? ms : age);
    }
  }
}

// Overview of the map (the sky left out), with the client's depth range.
function fitMap() {
  if (!mapRoot) return;
  mapRoot.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const s of mapScenes) if (!s.sky) box.expandByObject(s.group);
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const size = box.isEmpty() ? new THREE.Vector3(2000, 2000, 2000) : box.getSize(new THREE.Vector3());
  const r = Math.max(500, Math.max(size.x, size.y, size.z) * 0.5);
  camera.near = 5;
  camera.far = 300000;
  camera.updateProjectionMatrix();
  controls.target.copy(c);
  camera.position.set(c.x + r * 0.6, c.y + r * 0.7, c.z + r * 0.9);
  controls.update();
  grid.visible = false;
  cameraPlaced = true;
}

// A weapon of the weapon table, as the game draws it (weaponScene.js), with
// its <sequence> effects on their weapon nodes. Q / E cycle its clips.
async function openWeapon(file) {
  clearNodes();
  current = null;
  scnFile = file;
  const scn = await loadScn(file);
  scnParsed = scn;
  const built = await buildWeaponScene(scn, f => loadTexture(f));
  weaponBuilt = built;
  world.add(built.group);
  built.update(tAbs, built.clips[0] || '');
  sceneAnimators = [{ animate: null, clips: built.clips }];
  clipIdx = 0; updateAnimHud();
  const failed = [];
  for (const fx of weaponFx) {
    try {
      const e = await buildEffect(fx.file, '');
      e.node = fx.node;
      built.group.add(e.group);
      weaponEffects.push(e);
    } catch (e) { failed.push(`${fx.file}: ${e.message}`); }
  }

  world.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(built.group, true);
  const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 100) : box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(1, sphere.radius) * 1.6;
  lastExtent = radius; lastFull = radius;
  if (!cameraPlaced || autoFit) { fitCamera(radius, radius, sphere.center, box.isEmpty() ? null : box.min.y); cameraPlaced = true; }
  buildBoneMarkers(scn, radius);

  $('#hud').innerHTML = `<b>${esc(file)}</b> · weapon<br>` +
    `${built.stats.meshes} meshes · ${Math.round(built.stats.tris)} triangles · ${scn.bones.length} bones · ` +
    `${built.clips.length} clips · ${built.stats.textures} textures · ${weaponEffects.length}/${weaponFx.length} effects` +
    (built.stats.untextured ? ` · <span style="color:#ff64c8">${built.stats.untextured} untextured</span>` : '');
  $('#info').innerHTML = `
    <div class="node">
      <div class="kv">weapon <b>${esc(file)}</b> · clips <b>${esc(built.clips.join(', '))}</b></div>
    </div>` + weaponEffects.map(fx => `
    <div class="node">
      <div><span class="cls">${esc(fx.file)}</span> <span class="nm">on ${esc(fx.node)}</span></div>
      <div class="kv">particle nodes <b>${fx.systems.length}</b> · models <b>${fx.models.length}</b> · ${fx.duration} ms loop</div>
    </div>`).join('') +
    (failed.length ? `<div class="node">${failed.map(t => `<div class="asset missing">⚠ ${esc(t)}</div>`).join('')}</div>` : '');
}

async function setCharacter(kind) {
  if (charaGroup) { charaGroup.removeFromParent(); disposeGroup(charaGroup); charaGroup = null; }
  if (!kind) return;
  try {
    const info = await (await fetch('/api/character/' + kind)).json();
    const { parts, skeleton, extraClips } = info;
    if (!parts?.length) return;

    if (kind.startsWith('bip_')) {
      const scn = await loadScn(parts[0]);
      const { group } = await buildScene(scn, f => loadTexture(f), charaPose());
      charaGroup = group; world.add(group);
      return;
    }

    gender = kind;
    const skel = await loadScn(skeleton);
    if (extraClips) {
      try { mergeClips(skel, await loadScn(extraClips)); } catch {}
    }
    charaSkelClips = skel.animNames;
    charaData = { skel, partScns: [] };
    equipSel = {};
    await loadItemCatalog(kind);
    charaClip = pickClip(skel);
    charaClipDur = clipDuration(skel, charaClip);
    paintClips();
    await rebuildCharacter();
  } catch (e) {
    $('#err').textContent = 'character: ' + e.message;
  }
}

let scnDuration = 0;
let charaData = null;
let charaSkelClips = [];
let charaClip = '';
let charaClipDur = 0;
let lastPose = 0;

function activeDuration() {
  if (current?.duration) return current.duration;
  if (scnDuration) return scnDuration;
  if (charaClipDur) return charaClipDur;
  return 5000;
}

function clipDuration(skel, name) {
  for (const b of skel.bones) for (const a of b.anims) if (a.name === name && a.duration) return a.duration;
  return 0;
}

function pickClip(skel) {
  for (const pref of ['00074', '00008']) if (skel.animNames.includes(pref)) return pref;
  for (const n of skel.animNames) {
    if (n === 'BASE') continue;
    if (clipDuration(skel, n) > 200) return n;
  }
  return skel.animNames[0] || '';
}

function charaPose() {
  return { clipA: charaClip || charaSkelClips[0] || '', clipB: '', tickA: Math.round(tMs), tickB: 0, blend: 0 };
}

let weaponScn = null;
let anchorName = 'R_Hand_Dummy';
let equipSel = {};
let gender = 'male';

async function rebuildCharacter() {
  if (!charaData) return;
  if (charaGroup) { charaGroup.removeFromParent(); disposeGroup(charaGroup); charaGroup = null; }

  const partScns = [];
  const attach = [];
  for (const slot of ['body', 'leg', 'foot', 'hand', 'face', 'hair']) {
    const it = equipSel[slot];
    const file = it ? it.part : `00_${gender}_${slot}.scn`;
    if (file) {
      try { partScns.push(await loadScn(file)); } catch {}
    }
    for (const n of (it?.nodes || [])) {
      try { attach.push({ scene: await loadScn(n.file), anchor: n.parent }); } catch {}
    }
  }
  for (const cat of ['accessories', 'pets']) {
    for (const n of (equipSel[cat]?.nodes || [])) {
      try { attach.push({ scene: await loadScn(n.file), anchor: n.parent }); } catch {}
    }
  }
  if (weaponScn) attach.push({ scene: weaponScn, anchor: anchorName });

  charaData.partScns = partScns;
  const { group } = await buildCharacter(
    charaData.skel, partScns, f => loadTexture(f), charaPose(), attach);
  charaGroup = group;
  charaAttach = attach;
  world.add(group);
}
let charaAttach = [];

function updateCharacterPose() {
  if (!charaData || !charaGroup || !charaSkelClips.length) return;
  const pieces = assembleFull(charaData.skel, charaData.partScns, charaAttach, charaPose());
  const meshes = charaGroup.children;
  const n = Math.min(pieces.length, meshes.length);
  for (let i = 0; i < n; i++) {
    if (meshes[i].isSprite) {   // billboard quad: move the sprite, never its shared geometry
      const f = quadFrame(pieces[i].positions);
      meshes[i].position.copy(f.center);
      meshes[i].scale.set(f.w, f.h, 1);
      continue;
    }
    const attr = meshes[i].geometry.attributes.position;
    if (!attr || attr.array.length !== pieces[i].positions.length) continue;
    attr.array.set(pieces[i].positions);
    attr.needsUpdate = true;
    meshes[i].geometry.computeVertexNormals();
  }
}

function pixelScale() {
  const h = Math.max(1, wrap.clientHeight) * Math.min(devicePixelRatio, 2);
  return h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

function fitCamera(focus, full = focus, center = new THREE.Vector3(), floorY = null) {
  const r = Math.max(10, focus);
  camera.near = Math.max(0.1, r / 500);
  camera.far = Math.max(full, r) * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  camera.position.set(center.x + r * 0.8, center.y + r * 1.1, center.z + r * 2.6);
  controls.update();

  scene.remove(grid);
  grid = new THREE.GridHelper(r * 2, 20, 0x2a3442, 0x1a2028);
  grid.position.set(center.x, floorY == null ? 0 : floorY, center.z);
  scene.add(grid);
}

async function build(seq) {
  clearNodes();
  const parts = seq.nodes.filter(n => n.emitters !== undefined);
  const texes = await Promise.all(
    parts.map(n => n.textures?.[0] ? loadTexture(n.textures[0].file) : Promise.resolve(null)));

  let loaded = 0, focus = 0, full = 0;
  parts.forEach((n, i) => {
    const sys = new ParticleNode(n, texes[i], 1);
    if (texes[i]) loaded++;
    focus = Math.max(focus, sys.focusExtent());
    full = Math.max(full, sys.fullExtent());
    world.add(sys.points);
    sysNodes.push(sys);
  });

  lastExtent = focus; lastFull = full;
  if (!cameraPlaced || autoFit) { fitCamera(focus, full); cameraPlaced = true; }
  else { camera.far = Math.max(full, lastExtent) * 20; camera.updateProjectionMatrix(); }
  const ps = pixelScale() * boost;
  for (const s of sysNodes) s.setPixelScale(ps);

  const scnRefs = [...new Set(seq.nodes.flatMap(n =>
    (n.assets || []).filter(a => a.ext === 'scn').map(a => a.file)))];
  let scnOk = 0;
  if (scnRefs.length) {
    const g = new THREE.Group();
    for (const f of scnRefs) {
      try {
        const scn = await loadScn(f);
        const built = await buildScene(scn, t => loadTexture(t));
        g.add(built.group);
        sceneAnimators.push({ animate: built.animate, worldOfAt: built.worldOfAt, clips: built.clips || [] });
        scnOk++;
      } catch {}
    }
    if (g.children.length) { seqScnGroup = g; world.add(g); }
    updateAnimHud();
  }

  const missingTex = parts.length - loaded;
  $('#hud').innerHTML =
    `<b>${seq._file}</b><br>${seq.duration} ms · ${seq.nodes.length} nodes · ` +
    `${parts.length} particle nodes · ${loaded} textures` +
    (scnRefs.length ? ` · ${scnOk}/${scnRefs.length} .scn scenes` : '') +
    (missingTex ? ` · <span style="color:#ff64c8">${missingTex} UNTEXTURED (magenta)</span>` : '') +
    ` · emission ${Math.round(focus)} u · travel ${Math.round(full)} u`;
}

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = now - last; last = now;

  const dur = activeDuration();
  const pb = scnFile ? scnPlayback : null;
  const from = pb && Number.isFinite(pb.from) ? Math.max(0, pb.from) : 0;
  const to = pb && pb.to > from ? Math.min(pb.to, dur) : dur;
  if (playing) {
    const step = dt * (pb && Number.isFinite(pb.speed) && pb.speed > 0 ? pb.speed : 1);
    tMs += step; tAbs += step;
    if (tMs >= to) tMs = pb && pb.loop === false ? to : from;
    if (tMs < from) tMs = from;
    $('#scrub').value = String(Math.round(1000 * tMs / Math.max(1, dur)));
    if (mapRoot) mapClock += dt;
  }
  $('#time').textContent = mapRoot ? `map ${Math.round(mapClock)} ms` : `${Math.round(tMs)} / ${Math.round(dur)} ms`;
  if (weaponBuilt) {
    const clip = weaponBuilt.clips.length ? weaponBuilt.clips[clipIdx % weaponBuilt.clips.length] : '';
    weaponBuilt.update(tAbs, clip);
    for (const fx of weaponEffects) {
      const w = weaponBuilt.nodeWorld(fx.node);
      fx.group.visible = !!w;
      if (w) fx.group.matrix.fromArray(w);
    }
    updateEffects(weaponEffects, tAbs, true);
  }
  if (mapRoot) {
    for (const s of mapScenes) s.update(mapClock);
    updateEffects(mapEffects, mapClock);
    if (mapSky) mapSky.position.copy(mapRoot.worldToLocal(camera.position.clone()));
  }
  const pbClip = pb && pb.clip ? pb.clip : null;
  const nodeClips = pb && pb.clipByNode && Object.keys(pb.clipByNode).length ? clipOfNode : null;
  for (const a of sceneAnimators) if (a.animate) a.animate(tMs, pbClip || (a.clips.length ? a.clips[clipIdx % a.clips.length] : ''), nodeClips);
  placeParticleNodes(pbClip, nodeClips);
  if (scnEffects.length && scnWorldOfAt) {
    const wOf = scnWorldOfAt(tMs, pbClip || (scnClips.length ? scnClips[clipIdx % scnClips.length] : ''), nodeClips);
    for (const fx of scnEffects) {
      const w = wOf(fx.node);
      fx.group.visible = !!w;
      if (w) fx.group.matrix.fromArray(w);
    }
    updateEffects(scnEffects, tAbs, true);
  }
  flyCamera(dt);
  syncBoneMarkers();
  if (current) {
    for (const s of sysNodes) s.update(tMs, tAbs);
    if (now - lastDiag > 250) { lastDiag = now; updateDiag(); }
  }
  if (playing && charaData && now - lastPose > 40) { lastPose = now; updateCharacterPose(); }
  controls.update();
  renderer.render(scene, camera);
}

// A particle node named after a node of one of the sequence's .scn scenes is
// drawn from that node (the client parents the CActParticle under it):
// crystal_plasma_sword_eff's ring*_Dummy arcs, line_Dummy sparks. The node's
// scale reaches the sizes only through ScaleFlagSize (ParticleNode).
function placeParticleNodes(pbClip, nodeClips) {
  const pending = sysNodes.filter(s => s.nodeName);
  if (!pending.length) return;
  const M = new THREE.Matrix4();
  for (const a of sceneAnimators) {
    if (!a.worldOfAt || !pending.length) continue;
    const wOf = a.worldOfAt(tMs, pbClip || (a.clips.length ? a.clips[clipIdx % a.clips.length] : ''), nodeClips);
    for (let i = pending.length; i-- > 0; ) {
      const s = pending[i];
      const w = wOf(s.nodeName);
      if (!w) continue;
      M.fromArray(w);                 // row-vector layout == column-major elements
      s.points.matrixAutoUpdate = false;
      s.points.matrix.copy(M);
      s.setNodeScale(Math.max(Math.hypot(w[0], w[1], w[2]), Math.hypot(w[4], w[5], w[6]), Math.hypot(w[8], w[9], w[10])));
      pending.splice(i, 1);
    }
  }
}

// Free camera: the orbit target and the eye move together, so the mouse keeps
// orbiting / panning around wherever you flew to. Speed scales with the
// orbit distance; Shift triples it.
function flyCamera(dt) {
  if (!flyKeys.size || pickedBone) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
  const move = new THREE.Vector3();
  if (flyKeys.has('w')) move.add(fwd);
  if (flyKeys.has('s')) move.sub(fwd);
  if (flyKeys.has('d')) move.add(right);
  if (flyKeys.has('a')) move.sub(right);
  if (flyKeys.has('r')) move.y += 1;
  if (flyKeys.has('f')) move.y -= 1;
  if (move.lengthSq() < 1e-9) return;
  // A map flies at a steady pace (its orbit distance is the whole map); an
  // object at its orbit distance per second.
  const speed = mapRoot ? 1200 : Math.max(20, camera.position.distanceTo(controls.target));
  move.normalize().multiplyScalar(speed * (dt / 1000) * (flyKeys.has('shift') ? 3 : 1));
  camera.position.add(move);
  controls.target.add(move);
}
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'r', 'f', 'shift'].includes(k)) flyKeys.add(k);
});
window.addEventListener('keyup', e => flyKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => flyKeys.clear());

let lastDiag = 0;
function updateDiag() {
  const total = sysNodes.reduce((a, s) => a + s.stats.alive, 0);
  const s0 = sysNodes[0];
  const p = s0?.stats.first;
  const d = p ? camera.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z)) : 0;
  const px = p ? Math.max(2, s0.stats.size * pixelScale() * boost / Math.max(1, d)) : 0;
  $('#diag').innerHTML =
    `alive <b>${total}</b> · node0 <b>${s0?.stats.alive ?? 0}</b>/${s0?.count ?? 0}` +
    (p ? ` · pos <b>${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}</b>` +
         ` · size <b>${s0.stats.size.toFixed(1)}</b>u → <b>${px.toFixed(1)}</b>px` +
         ` · dist <b>${d.toFixed(0)}</b>` : ' · no live particles') +
    ` · cam <b>${camera.position.length().toFixed(0)}</b>`;
}

$('#play').onclick = () => {
  playing = !playing;
  $('#play').textContent = playing ? '❚❚ Pause' : '▶ Play';
};
$('#play').textContent = '❚❚ Pause';
$('#reset').onclick = () => { tMs = 0; mapClock = 0; };
$('#scrub').oninput = e => { if (current) tMs = current.duration * (e.target.value / 1000); };

$('#boost').oninput = e => {
  boost = Math.pow(2, e.target.value / 10);
  $('#boostV').textContent = boost.toFixed(1);
  for (const s of sysNodes) s.setPixelScale(pixelScale() * boost);
};
$('#fit').onclick = () => { if (mapRoot) fitMap(); else if (current) fitCamera(lastExtent, lastFull); };
$('#autofit').onchange = e => { autoFit = e.target.checked; };

const fmt = v => !Number.isFinite(v) ? '—'
  : (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) ? v.toExponential(2) : v.toFixed(2);

function renderInfo(seq, have) {
  const rows = seq.nodes.map(n => {
    const assets = n.assets.map(a => {
      const h = have[a.file];
      if (!h?.ok) return `<div class="asset missing">⚠ ${a.path}</div>`;
      const note = h.swapped ? ` <span class="swap">→ ${h.as}</span>` : '';
      return `<div class="asset">${a.path}${note}</div>`;
    }).join('');

    let detail = '';
    if (n.emitters !== undefined) {
      const e = n.emitters[0];
      detail = `<div class="kv">
        start <b>${n.beginTime}</b> ms · end <b>${n.endTime}</b> ms ·
        max <b>${n.maxParticles}</b> · blend <b>${n.blendType}</b>
        ${n.fieldsOk ? '' : `<span class="missing">· ${n.derail || 'incomplete'}</span>`}
        </div>` + (e ? `<div class="kv">
        cone <b>${fmt(e.coneTheta)}</b>° · vel <b>${fmt(e.speed)}</b> ·
        life <b>${e.lifetime}</b> ms · <b>${e.perSecond}</b>/s ·
        grav <b>${fmt(e.gravity.y)}</b></div>` : '')
        + `<div class="kv">scene keys <b>${n.keys.length}</b> ·
             emitters <b>${n.emitters.length}</b></div>`;
    } else if (n.nodeDuration !== undefined) {
      detail = `<div class="kv">duration <b>${n.nodeDuration}</b></div>`;
    }

    return `<div class="node">
      <div><span class="cls">${n.className}</span>
        ${n.nodeName ? `<span class="nm">"${n.nodeName}"</span>` : ''}</div>
      <div class="kv">body <b>${n.bodySize}</b> B · @0x${n.fileOffset.toString(16)}</div>
      ${detail}${assets}</div>`;
  }).join('');

  $('#info').innerHTML = `
    <div class="node">
      <div class="kv">name <b>${seq.name || '(empty)'}</b></div>
      <div class="kv">duration <b>${seq.duration}</b> ms · flag <b>${seq.flag}</b></div>
      <div class="kv">nodes <b>${seq.nodes.length}</b> (header says ${seq.nodeCount})</div>
    </div>${rows}`;
}

async function open(file, el) {
  try {
    const buf = await (await fetch('/res/' + encodeURIComponent(file))).arrayBuffer();
    const seq = parseSeq(buf);
    seq._file = file;
    current = seq;
    scnFile = null; scnPlayback = null; scnData = null; scnParsed = null; clearBoneMarkers();
    tMs = 0; tAbs = 0;

    const files = [...new Set(seq.nodes.flatMap(n => n.assets.map(a => a.file)))];
    const have = files.length ? (await (await fetch('/api/have', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    })).json()).have : {};

    renderInfo(seq, have);
    await build(seq);
  } catch (e) {
    $('#err').textContent = `Error opening ${file}\n${e.stack || e.message}`;
  }
}

const lists = { seq: [], scn: [] };
let tab = 'seq';

async function openItem(name, el) {
  document.querySelectorAll('.item.sel').forEach(e => e.classList.remove('sel'));
  el?.classList.add('sel');
  $('#err').textContent = '';
  try {
    if (name.toLowerCase().endsWith('.scn')) await openScn(name);
    else await open(name, el);
  } catch (e) {
    $('#err').textContent = `Error opening ${name}\n${e.stack || e.message}`;
  }
}

function paint(filter = '') {
  const f = filter.toLowerCase();
  const all = lists[tab];
  const shown = all.filter(x => x.name.toLowerCase().includes(f)).slice(0, 3000);
  $('#items').innerHTML = shown.map(x =>
    `<div class="item" data-n="${x.name}">${x.name} <small>${x.size}B</small></div>`).join('');
  $('#items').querySelectorAll('.item').forEach(el => {
    el.onclick = () => openItem(el.dataset.n, el);
  });
  $('#count').textContent = `${shown.length}/${all.length}`;
}

$('#search').oninput = e => paint(e.target.value);
document.querySelectorAll('.tab').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    tab = b.dataset.k;
    $('#search').value = '';
    paint();
  };
});
$('#chara').onchange = e => setCharacter(e.target.value);
$('#clip').onchange = e => {
  charaClip = e.target.value;
  charaClipDur = charaData ? clipDuration(charaData.skel, charaClip) : 0;
  tMs = 0;
  updateCharacterPose();
};
$('#anchor').onchange = e => { anchorName = e.target.value; rebuildCharacter(); };
let animSetClips = [];
let animSetScript = '';

function paintClips() {
  if (!charaData) return;
  const dur = c => clipDuration(charaData.skel, c);
  const opt = c => `<option value="${c}"${c === charaClip ? ' selected' : ''}>${c} (${dur(c)}ms)</option>`;
  const weaponClips = animSetClips.filter(c => charaSkelClips.includes(c));
  const rest = charaSkelClips.filter(c => !weaponClips.includes(c));
  $('#clip').innerHTML =
    (weaponClips.length ? `<optgroup label="weapon — ${animSetScript}">${weaponClips.map(opt).join('')}</optgroup>` : '') +
    `<optgroup label="all (${rest.length})">${rest.map(opt).join('')}</optgroup>`;
}

$('#weapon').onchange = async e => {
  const f = e.target.value;
  weaponScn = null;
  animSetClips = []; animSetScript = '';
  if (f) {
    try { weaponScn = await loadScn(f); } catch (err) { $('#err').textContent = 'weapon: ' + err.message; }
    try {
      const d = await (await fetch('/api/animset?weapon=' + encodeURIComponent(f))).json();
      if (d.ok) {
        animSetClips = d.clips; animSetScript = d.script;
        const first = d.clips.find(c => charaSkelClips.includes(c));
        if (first) {
          charaClip = first;
          charaClipDur = clipDuration(charaData.skel, first);
          tMs = 0;
        }
      }
    } catch {}
  }
  paintClips();
  await rebuildCharacter();
};

async function loadItemCatalog(kind) {
  try {
    const d = await (await fetch('/api/items?sex=' + kind)).json();
    if (!d.ok) throw new Error(d.error || 'no data');
    const order = ['hair', 'face', 'body', 'leg', 'hand', 'foot', 'accessories', 'pets'];
    const titles = {
      hair: 'hair', face: 'face', body: 'torso', leg: 'legs',
      hand: 'hands', foot: 'feet', accessories: 'accessories', pets: 'pet',
    };
    const html = order.filter(s => d.bySlot[s]?.length).map(slot => {
      const list = d.bySlot[slot];
      return `<div class="slotbox"><h3>${titles[slot]} (${list.length})</h3>
        <select data-slot="${slot}">
          <option value="">— default —</option>
          ${list.map(it => `<option value="${it.key}">${it.name}</option>`).join('')}
        </select></div>`;
    }).join('');
    $('#equip').innerHTML = html || '<div class="slotbox">no items</div>';

    const byKey = new Map();
    for (const s of Object.keys(d.bySlot)) for (const it of d.bySlot[s]) byKey.set(String(it.key), it);
    $('#equip').querySelectorAll('select').forEach(sel => {
      sel.onchange = async () => {
        const slot = sel.dataset.slot;
        equipSel[slot] = sel.value ? byKey.get(sel.value) : null;
        await rebuildCharacter();
      };
    });
  } catch (e) {
    $('#equip').innerHTML = `<div class="slotbox">could not read item.x7<br><small>${e.message}</small></div>`;
  }
  await rebuildCharacter();
}

document.querySelectorAll('.stab').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.stab').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    const k = b.dataset.k;
    $('#info').hidden = k !== 'info';
    $('#equip').hidden = k !== 'equip';
    $('#editor').hidden = k !== 'edit';
    if (k === 'edit') renderEditor();
  };
});

let edData = null, edTimer = 0, edAllMode = false;

async function renderEditor() {
  const ed = $('#editor');
  if (scnFile) return renderScnEditor();
  if (!current || !current._file) { ed.innerHTML = '<div class="slotbox">Abre una secuencia o una escena.</div>'; return; }
  ed.innerHTML = '<div class="slotbox">loading…</div>';
  let r;
  try { r = await (await fetch('/api/seqjson?file=' + encodeURIComponent(current._file))).json(); }
  catch (e) { ed.innerHTML = '<div class="slotbox">error: ' + e.message + '</div>'; return; }
  if (!r.ok) { ed.innerHTML = '<div class="slotbox">' + (r.error || 'error') + '</div>'; return; }
  edData = r.seq;
  ed.innerHTML = '';

  const g = document.createElement('div'); g.className = 'edGlobal';
  const mode = document.createElement('label'); mode.className = 'edRow'; mode.style.marginBottom = '6px';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = edAllMode;
  cb.onchange = () => { edAllMode = cb.checked; renderEditor(); };
  const ms = document.createElement('span'); ms.textContent = 'Edit ALL nodes at once';
  mode.appendChild(ms); mode.appendChild(cb);
  g.appendChild(mode);
  g.appendChild(edRow('duration', edData.duration, 'duration'));
  g.appendChild(edRow('flag', edData.flag, 'flag'));
  ed.appendChild(g);

  const texSec = document.createElement('div'); texSec.id = 'edTex';
  ed.appendChild(texSec);
  renderTextures();

  if (edAllMode) {
    const keys = Object.keys(edData.nodes[0]?.fields || {});
    const det = document.createElement('details'); det.open = true;
    const sum = document.createElement('summary'); sum.textContent = `All nodes (${edData.nodes.length}) · ${keys.length} fields`;
    det.appendChild(sum);
    const body = document.createElement('div'); body.className = 'edBody';
    for (const k of keys) {
      const vals = edData.nodes.map(n => n.fields[k]);
      const diff = vals.some(v => v !== vals[0]);
      body.appendChild(edRow(k + (diff ? '  ≠' : ''), vals[0], 'all.' + k));
    }
    det.appendChild(body);
    ed.appendChild(det);
  } else {
    edData.nodes.forEach(n => {
      const keys = Object.keys(n.fields || {});
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = `#${n.i} ${n.className}${n.nodeName ? ' · ' + n.nodeName : ''} (${keys.length})`;
      det.appendChild(sum);
      const body = document.createElement('div'); body.className = 'edBody';
      for (const k of keys) body.appendChild(edRow(k, n.fields[k], 'n' + n.i + '.' + k));
      det.appendChild(body);
      ed.appendChild(det);
    });
  }

  const foot = document.createElement('div'); foot.className = 'edSave'; foot.id = 'edStatus';
  foot.textContent = edAllMode ? 'edit 1 field → applies to all ' + edData.nodes.length + ' nodes and restarts' : 'edit any value → applies and restarts automatically';
  ed.appendChild(foot);
}

// ------------------------------------------------------------- bone gizmo
// Click a bone marker to grab it, drag to pose it. On release the new local
// transform is decomposed back into initT/initR/initS and written to the .scn.
//
// A bone whose clip carries keys for a channel ignores the init value for that
// channel (sampleVec falls back to init only when the key list is empty), so
// dragging it would snap back on the next frame. Those bones are marked and
// locked instead of silently doing nothing.


function ensureGizmo() {
  if (tcontrol) return tcontrol;
  tcontrol = new TransformControls(camera, renderer.domElement);
  tcontrol.space = 'local';
  // three 0.185 dropped dragging-changed; mouseDown/mouseUp carry the same signal
  tcontrol.addEventListener('mouseDown', () => { controls.enabled = false; });
  tcontrol.addEventListener('mouseUp', () => { controls.enabled = true; commitBone(); });
  const helper = tcontrol.getHelper ? tcontrol.getHelper() : tcontrol;
  scene.add(helper);
  return tcontrol;
}

function clearBoneMarkers() {
  if (tcontrol) { tcontrol.detach(); }
  pickedBone = null;
  if (!boneMarkers) return;
  boneMarkers.removeFromParent();
  boneMarkers.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  boneMarkers = null;
}

function buildBoneMarkers(scn, radius) {
  clearBoneMarkers();
  if (!scn.bones.length) return;
  boneMarkers = new THREE.Group();
  boneMarkers.name = '__bones';
  const size = Math.max(0.5, radius * 0.02);
  const geo = new THREE.OctahedronGeometry(size);
  for (const b of scn.bones) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x37c8ff, depthTest: false, transparent: true, opacity: 0.85 });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1e6;
    m.userData.bone = b.name;
    boneMarkers.add(m);
  }
  world.add(boneMarkers);
  syncBoneMarkers();
}

function boneWorlds() {
  if (!scnParsed) return null;
  const pb = scnPlayback;
  const pose = { clipA: (pb && pb.clip) || currentClip(), clipB: '', tickA: tMs | 0, tickB: 0, blend: 0 };
  return { pose, world: resolveBoneWorlds(scnParsed, pose) };
}

function syncBoneMarkers() {
  if (!boneMarkers || !scnParsed) return;
  const bw = boneWorlds();
  if (!bw) return;
  boneMarkers.children.forEach((m, i) => {
    if (m === pickedBone) return;
    m.matrixAutoUpdate = false;
    m.matrix.fromArray(bw.world[i]);
    m.matrixWorldNeedsUpdate = true;
  });
}

function boneParentWorld(name) {
  const b = scnParsed.bones.find(x => x.name === name);
  if (!b || !b.parent) return null;
  const worldOf = nodeResolver(scnParsed, {
    clipA: (scnPlayback && scnPlayback.clip) || currentClip(), clipB: '', tickA: tMs | 0, tickB: 0, blend: 0,
  });
  return worldOf(b.parent) || null;
}

function pickBone(ev) {
  if (!boneMarkers) return;
  // a click that lands on a gizmo axis belongs to the gizmo, not to picking
  if (tcontrol && (tcontrol.dragging || tcontrol.axis)) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  rayc.setFromCamera(ndc, camera);
  const hit = rayc.intersectObjects(boneMarkers.children, false)[0];
  if (!hit) return;
  selectBone(hit.object);
}

function selectBone(marker) {
  pickedBone = marker;
  marker.matrixAutoUpdate = true;
  marker.matrix.decompose(marker.position, marker.quaternion, marker.scale);
  ensureGizmo().attach(marker);
  const locked = lockedChannels(marker.userData.bone);
  const st = $('#edStatus');
  if (st) {
    st.textContent = locked.length
      ? marker.userData.bone + ' · ' + locked.join('/') + ' con keys en este clip, no se puede editar aqui'
      : marker.userData.bone + ' · arrastra para posar, se escribe al soltar';
  }
}

function lockedChannels(boneName) {
  const p = scnData && scnData.pose && scnData.pose[boneName];
  if (!p) return [];
  const out = [];
  if (p.trans && p.trans.length) out.push('mover');
  if (p.rot && p.rot.length) out.push('rotar');
  if (p.scale && p.scale.length) out.push('escalar');
  return out;
}

function commitBone() {
  if (!pickedBone || !scnParsed || !scnData) return;
  const name = pickedBone.userData.bone;
  const p = scnData.pose && scnData.pose[name];
  const st = $('#edStatus');
  if (!p) { if (st) st.textContent = name + ' no tiene pose en el clip "' + (scnData.clip || '') + '"'; syncBoneMarkers(); return; }

  pickedBone.updateMatrix();
  const world = pickedBone.matrix.toArray();
  const pw = boneParentWorld(name);
  const local = pw ? mat4Mul(world, mat4InvAffine(pw)) : world;

  const M = new THREE.Matrix4().fromArray(local);
  const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  M.decompose(t, q, s);

  const locked = lockedChannels(name);
  if (!locked.includes('mover')) p.initT = [t.x, t.y, t.z];
  if (!locked.includes('rotar')) p.initR = [q.x, q.y, q.z, q.w];
  if (!locked.includes('escalar')) p.initS = [s.x, s.y, s.z];

  if (locked.length === 3) {
    if (st) st.textContent = name + ': todos los canales tienen keys, nada que escribir';
    syncBoneMarkers();
    return;
  }
  pushScnEdit();
}

function setGizmoMode(mode) {
  ensureGizmo().setMode(mode);
  const st = $('#edStatus');
  if (st && pickedBone) st.textContent = pickedBone.userData.bone + ' · modo ' + mode;
}

// ---------------------------------------------------------------- SCN editor
// Two layers, on purpose:
//   * .scn writes  -> matrices and clip poses, patched in place by scncodec
//   * playback     -> a <name>.playback.json next to the file, holding what to
//                     play, from/to, speed and per node clip overrides. The .scn
//                     format has nowhere to store any of that.

const MLABEL = ['m0','m1','m2','m3','m4','m5','m6','m7','m8','m9','m10','m11','posX','posY','posZ','m15'];

function currentClip() {
  const c = allClips();
  return c.length ? c[clipIdx % c.length] : '';
}

function clipOfNode(name) {
  const map = scnPlayback && scnPlayback.clipByNode;
  return map && map[name] ? map[name] : null;
}

async function renderScnEditor() {
  const ed = $('#editor');
  ed.innerHTML = '<div class="slotbox">cargando…</div>';
  const clip = currentClip();
  let r, pb;
  try {
    r = await (await fetch('/api/scnjson?file=' + encodeURIComponent(scnFile) + '&clip=' + encodeURIComponent(clip))).json();
    pb = await (await fetch('/api/scnplayback?file=' + encodeURIComponent(scnFile))).json();
  } catch (e) { ed.innerHTML = '<div class="slotbox">error: ' + e.message + '</div>'; return; }
  if (!r.ok) { ed.innerHTML = '<div class="slotbox">' + (r.error || 'error') + '</div>'; return; }

  scnData = r.scn;
  const clips = scnData.clipList || [];
  const dur = Math.round(activeDuration());
  scnPlayback = (pb && pb.ok && pb.playback) || { clip: clip, from: 0, to: dur, speed: 1, loop: true, clipByNode: {} };
  if (!scnPlayback.clipByNode) scnPlayback.clipByNode = {};
  if (!(scnPlayback.to > 0)) scnPlayback.to = dur;
  ed.innerHTML = '';

  const g = document.createElement('div'); g.className = 'edGlobal';
  g.appendChild(pbSelect('Reproducir', 'clip', clips, scnPlayback.clip));
  g.appendChild(pbNumber('Desde (ms)', 'from', scnPlayback.from));
  g.appendChild(pbNumber('Hasta (ms)', 'to', scnPlayback.to));
  g.appendChild(pbNumber('Velocidad', 'speed', scnPlayback.speed));
  g.appendChild(pbCheck('Bucle', 'loop', scnPlayback.loop !== false));
  const bar = document.createElement('div'); bar.className = 'edRow';
  const bl = document.createElement('span'); bl.textContent = 'Hueso';
  bar.appendChild(bl);
  const bw = document.createElement('span');
  [['translate','Mover (G)'],['rotate','Rotar (R)'],['scale','Escalar (S)']].forEach(([mode, label]) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'margin-left:4px;background:#16324f;color:#e8edf3;border:1px solid var(--line);border-radius:4px;padding:2px 6px;cursor:pointer';
    btn.onclick = () => setGizmoMode(mode);
    bw.appendChild(btn);
  });
  bar.appendChild(bw);
  g.appendChild(bar);

  const hint = document.createElement('div');
  hint.style.cssText = 'color:#9aa4b2;padding-top:4px';
  hint.textContent = 'duracion ' + dur + ' ms · se guarda junto al .scn, no dentro';
  g.appendChild(hint);
  ed.appendChild(g);

  const nodes = [].concat(scnData.models || [], scnData.bones || []);
  for (const n of nodes) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    const own = (n.clips || []).length;
    sum.textContent = (n.name || '(sin nombre)') + (own ? ' · ' + own + ' clips' : '');
    det.appendChild(sum);
    const body = document.createElement('div'); body.className = 'edBody';
    if (clips.length) body.appendChild(nodeClipSelect(n.name, clips));
    (n.matrix || []).forEach((v, i) => body.appendChild(scnRow(MLABEL[i] || ('m' + i), v, 'mat.' + n.name + '.' + i)));
    det.appendChild(body);
    ed.appendChild(det);
  }

  // ponytail: init pose only. One row per key per bone would be thousands of
  // inputs; add key level editing when an actual edit needs it.
  const pose = scnData.pose || {};
  const boneNames = Object.keys(pose);
  if (boneNames.length) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = 'Pose de "' + scnData.clip + '" (' + boneNames.length + ' huesos)';
    det.appendChild(sum);
    const body = document.createElement('div'); body.className = 'edBody';
    for (const bn of boneNames) {
      const p = pose[bn];
      const sub = document.createElement('details');
      const ss = document.createElement('summary');
      ss.textContent = bn + ' · ' + p.rot.length + 'R ' + p.trans.length + 'T ' + p.scale.length + 'S';
      sub.appendChild(ss);
      const sb = document.createElement('div'); sb.className = 'edBody';
      p.initT.forEach((v, i) => sb.appendChild(scnRow('initT' + 'XYZ'[i], v, 'pose.' + bn + '.initT.' + i)));
      p.initR.forEach((v, i) => sb.appendChild(scnRow('initR' + 'XYZW'[i], v, 'pose.' + bn + '.initR.' + i)));
      p.initS.forEach((v, i) => sb.appendChild(scnRow('initS' + 'XYZ'[i], v, 'pose.' + bn + '.initS.' + i)));
      sub.appendChild(sb);
      body.appendChild(sub);
    }
    det.appendChild(body);
    ed.appendChild(det);
  }

  const foot = document.createElement('div'); foot.className = 'edSave'; foot.id = 'edStatus';
  foot.textContent = 'click en un rombo azul = coger hueso · G/R/S modo · Esc suelta';
  ed.appendChild(foot);
}

function scnRow(label, value, key) {
  const row = document.createElement('label'); row.className = 'edRow';
  const span = document.createElement('span'); span.textContent = label; span.title = key;
  const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.value = value;
  inp.addEventListener('input', () => scheduleScnEdit(key, inp.value));
  row.appendChild(span); row.appendChild(inp);
  return row;
}

function pbRow(label, control) {
  const row = document.createElement('label'); row.className = 'edRow';
  const span = document.createElement('span'); span.textContent = label;
  row.appendChild(span); row.appendChild(control);
  return row;
}

function pbNumber(label, field, value) {
  const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.value = value;
  inp.addEventListener('input', () => {
    const v = Number(inp.value);
    if (Number.isFinite(v)) { scnPlayback[field] = v; schedulePlayback(); }
  });
  return pbRow(label, inp);
}

function pbCheck(label, field, value) {
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = value;
  inp.addEventListener('change', () => { scnPlayback[field] = inp.checked; schedulePlayback(); });
  return pbRow(label, inp);
}

function optionsHtml(list, value, first) {
  return first + list.map(c => '<option' + (c === value ? ' selected' : '') + '>' + c + '</option>').join('');
}

function pbSelect(label, field, options, value) {
  const sel = document.createElement('select');
  sel.innerHTML = optionsHtml(options, value, '<option value="">—</option>');
  sel.addEventListener('change', () => { scnPlayback[field] = sel.value; schedulePlayback(); });
  return pbRow(label, sel);
}

function nodeClipSelect(name, options) {
  const sel = document.createElement('select');
  sel.innerHTML = optionsHtml(options, scnPlayback.clipByNode[name] || '', '<option value="">(clip global)</option>');
  sel.addEventListener('change', () => {
    if (sel.value) scnPlayback.clipByNode[name] = sel.value;
    else delete scnPlayback.clipByNode[name];
    schedulePlayback();
  });
  return pbRow('clip de esta pieza', sel);
}

function schedulePlayback() {
  clearTimeout(pbTimer);
  pbTimer = setTimeout(async () => {
    const status = $('#edStatus');
    try {
      const res = await (await fetch('/api/scnplayback?file=' + encodeURIComponent(scnFile), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scnPlayback),
      })).json();
      if (status) status.textContent = res.ok ? 'reproduccion guardada en ' + res.file : 'error: ' + res.error;
    } catch (e) { if (status) status.textContent = 'error: ' + e.message; }
  }, 300);
}

function scheduleScnEdit(key, raw) {
  if (!scnData) return;
  const val = Number(raw);
  if (!Number.isFinite(val)) return;
  const m = key.match(/^mat\.(.+)\.(\d+)$/);
  if (m) {
    const node = [].concat(scnData.models || [], scnData.bones || []).find(x => x.name === m[1]);
    if (node && node.matrix) node.matrix[+m[2]] = val;
  } else {
    const q = key.match(/^pose\.(.+)\.(initT|initR|initS)\.(\d+)$/);
    if (q && scnData.pose && scnData.pose[q[1]]) scnData.pose[q[1]][q[2]][+q[3]] = val;
  }
  clearTimeout(scnTimer);
  scnTimer = setTimeout(pushScnEdit, 300);
}

async function pushScnEdit() {
  if (!scnData || !scnFile) return;
  const status = $('#edStatus');
  const keepPlayback = scnPlayback;
  try {
    const res = await (await fetch('/api/scnsave?file=' + encodeURIComponent(scnFile), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scnData),
    })).json();
    if (!res.ok) { if (status) status.textContent = 'error: ' + res.error; return; }
    const keep = tMs;
    await openScn(scnFile);
    scnPlayback = keepPlayback;
    tMs = keep;
    const st = $('#edStatus');
    if (st) st.textContent = 'escrito (' + res.patched + ' campos)';
  } catch (e) { if (status) status.textContent = 'error: ' + e.message; }
}

function edRow(label, value, key) {
  const row = document.createElement('label'); row.className = 'edRow';
  const span = document.createElement('span'); span.textContent = label; span.title = label;
  const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.value = value; inp.dataset.key = key;
  inp.addEventListener('input', () => scheduleEdit(key, inp.value));
  row.appendChild(span); row.appendChild(inp);
  return row;
}

function scheduleEdit(key, raw) {
  if (!edData) return;
  const val = Number(raw);
  if (!Number.isFinite(val)) return;
  if (key === 'duration') edData.duration = val;
  else if (key === 'flag') edData.flag = val;
  else if (key.startsWith('all.')) { const fk = key.slice(4); for (const node of edData.nodes) if (fk in node.fields) node.fields[fk] = val; }
  else { const m = key.match(/^n(\d+)\.(.+)$/); if (m) { const node = edData.nodes.find(x => x.i === +m[1]); if (node) node.fields[m[2]] = val; } }
  clearTimeout(edTimer);
  edTimer = setTimeout(pushEdit, 250);
}

async function pushEdit() {
  if (!edData || !current || !current._file) return;
  const status = $('#edStatus');
  try {
    const res = await (await fetch('/api/seqsave?file=' + encodeURIComponent(current._file), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edData),
    })).json();
    if (!res.ok) { if (status) status.textContent = 'error: ' + res.error; return; }
    if (status) status.textContent = `applied (${res.patched} fields) · restarted`;
    playing = true;
    await open(current._file);
  } catch (e) { if (status) status.textContent = 'error: ' + e.message; }
}

async function renderTextures() {
  const box = $('#edTex'); if (!box) return;
  box.innerHTML = '';
  let tj, tl;
  try {
    tj = await (await fetch('/api/seqtextures?file=' + encodeURIComponent(current._file))).json();
    tl = await (await fetch('/api/seqtexlist')).json();
  } catch (e) { return; }
  if (!tj.ok || !tj.textures.length) return;

  const det = document.createElement('details'); det.open = true;
  const sum = document.createElement('summary'); sum.textContent = `Textures (${tj.textures.length})`;
  det.appendChild(sum);
  const body = document.createElement('div'); body.className = 'edBody';

  const dl = document.createElement('datalist'); dl.id = 'texOptions';
  (tl.files || []).forEach(f => { const o = document.createElement('option'); o.value = f; dl.appendChild(o); });
  body.appendChild(dl);

  tj.textures.forEach(t => {
    const nameMax = t.maxLen - (t.text.length - t.file.length);
    const row = document.createElement('div'); row.className = 'edRow';
    const span = document.createElement('span'); span.textContent = t.file; span.title = t.text + '\nname max ' + nameMax + ' characters (same folder)';
    const inp = document.createElement('input'); inp.type = 'text'; inp.setAttribute('list', 'texOptions');
    inp.value = t.file; inp.style.width = '150px'; inp.maxLength = nameMax;
    inp.addEventListener('change', () => swapTexture(t, inp.value.trim(), inp));
    row.appendChild(span); row.appendChild(inp);
    body.appendChild(row);
  });
  det.appendChild(body);
  box.appendChild(det);
}

async function swapTexture(t, newFile, inp) {
  if (!newFile || newFile === t.file) return;
  const sep = t.text.includes('\\') ? '\\' : (t.text.includes('/') ? '/' : '');
  const dir = sep ? t.text.slice(0, t.text.lastIndexOf(sep) + 1) : '';
  const status = $('#edStatus');
  try {
    const res = await (await fetch('/api/seqtexpatch?file=' + encodeURIComponent(current._file), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ old: t.text, new: dir + newFile }),
    })).json();
    if (!res.ok) { if (status) status.textContent = 'texture: ' + res.error; inp.value = t.file; return; }
    if (status) status.textContent = `texture → ${newFile} (${res.changed}) · restarted`;
    playing = true;
    await open(current._file);
    renderTextures();
  } catch (e) { if (status) status.textContent = 'error: ' + e.message; inp.value = t.file; }
}

fetch('/api/weapons').then(r => r.json()).then(d => {
  if (!d.ok) return;
  $('#weapon').innerHTML = '<option value="">none</option>' +
    d.files.map(x => `<option value="${x.file}">${x.file.replace(/\.scn$/, '')}</option>`).join('');
}).catch(() => {});

Promise.all([
  fetch('/api/sequences').then(r => r.json()),
  fetch('/api/scenes').then(r => r.json()),
]).then(([s, c]) => {
  if (!s.ok) throw new Error(s.error);
  lists.seq = s.files;
  lists.scn = c.ok ? c.files : [];
  document.querySelector('.tab[data-k="seq"]').textContent = `Sequences (${lists.seq.length})`;
  document.querySelector('.tab[data-k="scn"]').textContent = `Scenes (${lists.scn.length})`;
  paint();
  const q = new URLSearchParams(location.search);
  const wantMap = q.get('map');
  const wantSeq = q.get('seq');
  const wantScn = q.get('scn');
  const hitSeq = wantSeq && lists.seq.find(f => f.name.toLowerCase() === wantSeq.toLowerCase());
  const hitScn = wantScn && lists.scn.find(f => f.name.toLowerCase() === wantScn.toLowerCase());
  if (wantMap) { document.querySelector('.tab[data-k="scn"]').click?.(); openMap(wantMap).catch(e => { $('#err').textContent = `Error opening the map\n${e.stack || e.message}`; }); }
  else if (hitScn) { document.querySelector('.tab[data-k="scn"]').click?.(); openItem(hitScn.name, null); }
  else if (hitSeq) openItem(hitSeq.name, null);
  else if (lists.seq.length) openItem(lists.seq[0].name, $('#items .item'));
}).catch(e => { $('#err').textContent = String(e); });

// Start the render loop last: it touches module state declared all over this
// file, and running it mid evaluation puts those bindings in the TDZ.
frame();
