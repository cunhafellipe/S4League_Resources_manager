// A map scene drawn the way the game's map pass draws it: every model at its
// node place (its own matrix, or the node chain when it hangs under another
// node), the scene's first clip looping on the client clock for the nodes that
// move, opacity / vertex / UV keys, the lightmap stage (texture x lightmap x 2)
// and back faces culled as the client's per-material cull mode does (two-sided
// only for NoCull materials, billboards and the sky dome: drawn two-sided, the
// far side of a thin wall or floor z-fights its near side from a distance -
// stripes that move with the camera). oct_* collision hulls and sector* team
// volumes are not scenery.
import * as THREE from 'three';
import { mat4Mul, buildTRS, resolveBoneWorlds, composeTRS, sampleBonePose } from './scnSkin.js';

export const TICKS_PER_MS = 4.8;   // the client's animation clock: elapsed ms * 4.8 (3ds Max ticks)

const RF_TRANSPARENT = 2, RF_CUTOUT = 4, RF_NO_CULLING = 8, RF_BILLBOARD = 16, RF_FLARE = 32, RF_NO_DEPTH_WRITE = 64;
const isBillboard = m => (m.name || '').toLowerCase().includes('billboard') || !!((m.renderFlag || 0) & RF_BILLBOARD);
const IDENT16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fileOf = p => String(p).split(/[\\/]/).pop();
const moving = a => !!((a.trans && a.trans.length) || (a.rot && a.rot.length) || (a.scale && a.scale.length));
const isIdentity = M => M.every((v, k) => Math.abs(v - (k % 5 === 0 ? 1 : 0)) < 1e-4);

export const isMapScenery = m => !m.name.startsWith('oct_') && !m.name.startsWith('sector');

// A node's own track: "BASE", else its first transform track.
function ownTrack(anims) {
  return anims.find(a => a.hasTransform && a.name === 'BASE') || anims.find(a => a.hasTransform) || null;
}

export function nodeIndex(sc) {
  return {
    model: new Map(sc.models.map(m => [m.name, m])),
    bone: new Map(sc.bones.map(b => [b.name, b])),
    box: new Map((sc.boxes || []).map(b => [b.name, b])),
    boneIdx: new Map(sc.bones.map((b, i) => [b.name, i])),
  };
}

// The node chain's own tracks up to the scene root: where a model hung under
// another node sits (ST1's bridge, ST2's pillars). The track-less identity
// container (BONESYSTEM) is passed through.
function trackWorld(idx, name) {
  let acc = IDENT16.slice(), cur = name;
  for (let depth = 0; depth < 64; depth++) {
    const node = idx.model.get(cur) || idx.bone.get(cur);
    if (!node) return depth > 0 ? acc : null;
    const t = ownTrack(node.anims || []);
    if (!t) {
      if (!isIdentity(node.matrix)) return null;
      cur = node.parent;
      continue;
    }
    acc = mat4Mul(acc, buildTRS(t.initT, t.initR, t.initS));
    cur = node.parent;
  }
  return null;
}

// Static place of a model: its matrix, or the node chain when its parent is a
// node of the scene.
export function mapModelWorld(idx, m) {
  const hung = idx.model.has(m.parent) || idx.bone.has(m.parent) || idx.box.has(m.parent);
  return (hung && trackWorld(idx, m.name)) || m.matrix;
}

// World of a node at a tick of the scene clip: bones from the skeleton pose,
// models from the clip's track (else their own track) under their parent.
export function mapResolver(sc, idx, clip, tick) {
  const pose = { clipA: clip, clipB: '', tickA: tick, tickB: 0, blend: 0 };
  const boneWorlds = sc.bones.length ? resolveBoneWorlds(sc, pose) : null;
  const cache = new Map();
  const resolve = (name, depth = 0) => {
    if (!name || depth > 16) return null;
    if (cache.has(name)) return cache.get(name);
    let w = null;
    const bi = idx.boneIdx.get(name);
    if (bi !== undefined && boneWorlds) {
      w = boneWorlds[bi];
      // a skeleton hung under a model follows that model
      let top = sc.bones[bi];
      for (let g = 0; g < 64; g++) {
        const pi = idx.boneIdx.get(top.parent);
        if (pi === undefined) break;
        top = sc.bones[pi];
      }
      if (idx.model.has(top.parent) && sampleBonePose(top, pose)) {
        const pw = resolve(top.parent, depth + 1);
        if (pw) w = mat4Mul(w, pw);
      }
    } else {
      const m = idx.model.get(name);
      if (m) {
        const clipAnim = clip ? m.anims.find(a => a.name === clip && a.hasTransform) : null;
        const own = clipAnim ? null : ownTrack(m.anims);
        if (clipAnim || own) {
          const local = clipAnim ? composeTRS(clipAnim, tick) : buildTRS(own.initT, own.initR, own.initS);
          const p = m.parent ? resolve(m.parent, depth + 1) : null;
          w = p ? mat4Mul(local, p) : local;
        } else {
          w = m.matrix;
        }
      }
    }
    cache.set(name, w);
    return w;
  };
  return resolve;
}

// Opacity of a model at a tick: the clip's track (or its only one).
export function modelVisibility(m, clip, tick) {
  let a = m.anims.find(x => x.name === clip) || null;
  if (!a && m.anims.length === 1) a = m.anims[0];
  if (!a || !a.vis || !a.vis.length) return 1;
  const t = a.duration ? tick % a.duration : tick;
  const k = a.vis;
  if (t <= k[0].t) return k[0].v;
  if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      const span = k[i].t - k[i - 1].t;
      const f = span > 0 ? (t - k[i - 1].t) / span : 1;
      return k[i - 1].v + (k[i].v - k[i - 1].v) * f;
    }
  }
  return k[k.length - 1].v;
}

export function morphTrackOf(m, clip, field) {
  const has = field === 'verts' ? (a => a.morph && a.morph.length > 0) : (a => a.morph && a.morph.some(k => k.uvs.length));
  return m.anims.find(a => a.name === clip && has(a)) || m.anims.find(has) || null;
}

// Vertex / UV keys: per vertex the last key at or before t that names it and
// the next one after t, linearly between them; before its first key the
// file's own value.
export function sampleMorph(a, base, stride, field, tick, out) {
  const t = a.duration ? tick % a.duration : tick;
  const nv = base.length / stride;
  out.set(base);
  const prevK = new Int32Array(nv).fill(-1), prevI = new Int32Array(nv);
  const nextK = new Int32Array(nv).fill(-1), nextI = new Int32Array(nv);
  for (let k = 0; k < a.morph.length; k++) {
    const list = a.morph[k][field];
    for (let i = 0; i < list.length; i++) {
      const v = list[i].index;
      if (v >= nv) continue;
      if (a.morph[k].tick <= t) { prevK[v] = k; prevI[v] = i; }
      else if (nextK[v] < 0) { nextK[v] = k; nextI[v] = i; }
    }
  }
  const valueOf = (e, c) => (field === 'verts' ? e.pos[c] : c === 0 ? e.u : e.v);
  for (let v = 0; v < nv; v++) {
    if (prevK[v] < 0 && nextK[v] < 0) continue;
    let t0 = 0;
    if (prevK[v] >= 0) {
      const e = a.morph[prevK[v]][field][prevI[v]];
      for (let c = 0; c < stride; c++) out[v * stride + c] = valueOf(e, c);
      t0 = a.morph[prevK[v]].tick;
    }
    if (nextK[v] >= 0) {
      const e = a.morph[nextK[v]][field][nextI[v]];
      const t1 = a.morph[nextK[v]].tick, span = t1 - t0;
      const f = Math.min(1, Math.max(0, span > 0 ? (t - t0) / span : 1));
      for (let c = 0; c < stride; c++) {
        const p0 = out[v * stride + c];
        out[v * stride + c] = p0 + (valueOf(e, c) - p0) * f;
      }
    }
  }
}

// The lightmap stage (D3D MODULATE2X): texture x lightmap x 2 on the stored
// (sRGB) values, the way the fixed pipeline combines them.
function modulate2x(mat) {
  mat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
      `vec3 outgoingLight = reflectedLight.indirectDiffuse;
      #ifdef USE_LIGHTMAP
        vec3 texGamma = sRGBTransferOETF( vec4( diffuseColor.rgb, 1.0 ) ).rgb;
        vec3 lmGamma = sRGBTransferOETF( vec4( lightMapTexel.rgb, 1.0 ) ).rgb;
        outgoingLight = sRGBTransferEOTF( vec4( min( texGamma * lmGamma * 2.0, vec3( 1.0 ) ), 1.0 ) ).rgb;
      #endif`);
  };
  mat.customProgramCacheKey = () => 'map-modulate2x';
}

// A lightmap reads the second UV set; the texture object may also be someone's
// main texture, so the lightmap use is a clone (same image on the GPU).
const lightmaps = new WeakMap();
function asLightmap(t) {
  let c = lightmaps.get(t);
  if (!c) { c = t.clone(); c.channel = 1; c.needsUpdate = true; lightmaps.set(t, c); }
  return c;
}

// Render state from the model's RenderFlag, as the map pass sets it: 2 alpha
// blend, 32 additive (flare / alphablend2), 4 alpha test, 64 no depth write.
// A lightmapped material draws without blending (alpha test for cutouts only);
// a fading one (opacity key) blends without depth writes and without lightmap.
function mapMaterial(tex, lm, flags, sky, fading = false) {
  const additive = !!(flags & RF_FLARE);
  const transparent = !!(flags & RF_TRANSPARENT) || additive;
  const cutout = !!(flags & RF_CUTOUT) && !additive;
  const lit = !!(tex && lm) && !fading;
  const blend = !!tex && (fading || (!lit && transparent));
  const mat = new THREE.MeshBasicMaterial({
    map: tex || null,
    side: sky || (flags & RF_NO_CULLING) ? THREE.DoubleSide : THREE.FrontSide,
    transparent: blend && !sky,   // the sky stays in the first (opaque) pass: drawn before everything
    blending: blend && additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    alphaTest: !tex ? 0 : cutout ? 128 / 255 : (!lit && transparent ? 8 / 255 : 0),
    depthWrite: !(flags & RF_NO_DEPTH_WRITE) && !(fading && tex),
    depthTest: !sky,
    fog: false,
  });
  if (lit) { mat.lightMap = asLightmap(lm); modulate2x(mat); }
  return mat;
}

const itemsOf = m => (m.texItems && m.texItems.length)
  ? m.texItems
  : [{ name: m.texture || '', side: '', faceStart: 0, faceCount: m.indices.length / 3 }];
const hasUv2 = m => !!(m.uvs2 && m.uvs2.length === (m.positions.length / 3) * 2);

// renderBase: draw order of this scene among the map's (the client draws the
// scenes in the bginfo order, the sky first, each one's models in file order).
export async function buildMapScene(scn, getTexture, { sky = false, renderBase = 0 } = {}) {
  const idx = nodeIndex(scn);
  const clip = scn.animNames.length ? scn.animNames[0] : '';
  const anyMoving = !!clip && scn.models.some(m => m.anims.some(moving));
  const stats = { meshes: 0, tris: 0, textures: 0, untextured: 0, lightmaps: 0 };
  const shown = scn.meshes.filter(isMapScenery);

  const wanted = new Set();
  for (const m of shown) {
    for (const it of itemsOf(m)) {
      if (it.name) wanted.add(fileOf(it.name));
      if (it.side && hasUv2(m)) wanted.add(fileOf(it.side));
    }
  }
  const texMap = new Map();
  await Promise.all([...wanted].map(async f => texMap.set(f, await getTexture(f))));

  const group = new THREE.Group();
  const live = [];
  let order = 0;
  for (const m of shown) {
    const nv = m.positions.length / 3;
    const g = new THREE.BufferGeometry();
    const pm = clip ? morphTrackOf(m, clip, 'verts') : null;
    const um = clip ? morphTrackOf(m, clip, 'uvs') : null;
    const hasUv = !!(m.uvs && m.uvs.length === nv * 2);
    const pos = new THREE.BufferAttribute(pm ? new Float32Array(m.positions) : m.positions, 3);
    g.setAttribute('position', pos);
    const uv = hasUv ? new THREE.BufferAttribute(um ? new Float32Array(m.uvs) : m.uvs, 2) : null;
    if (uv) g.setAttribute('uv', uv);
    const uv2 = hasUv2(m);
    if (uv2) g.setAttribute('uv1', new THREE.BufferAttribute(m.uvs2, 2));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));

    const items = [], mats = [];
    const flags = (m.renderFlag || 0) | (isBillboard(m) ? RF_NO_CULLING : 0);   // a camera-facing quad has no back
    for (const it of itemsOf(m)) {
      const count = Math.min(it.faceCount * 3, m.indices.length - it.faceStart * 3);
      if (count <= 0) continue;
      const tex = it.name ? texMap.get(fileOf(it.name)) || null : null;
      const lm = uv2 && it.side ? texMap.get(fileOf(it.side)) || null : null;
      if (tex) stats.textures++; else stats.untextured++;
      if (tex && lm) stats.lightmaps++;
      g.addGroup(it.faceStart * 3, count, mats.length);
      items.push({ tex, lm });
      mats.push(mapMaterial(tex, lm, flags, sky));
    }
    if (!mats.length) continue;

    const mesh = new THREE.Mesh(g, mats);
    mesh.name = m.name || '(unnamed)';
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(mapModelWorld(idx, m));   // row-vector layout == column-major elements
    mesh.matrixWorldNeedsUpdate = true;
    mesh.renderOrder = renderBase + order++;
    if (pm || um || sky) mesh.frustumCulled = false;
    group.add(mesh);
    stats.meshes++;
    stats.tris += m.indices.length / 3;

    const moves = !!clip && m.anims.some(moving);
    const visTrack = clip ? (m.anims.find(x => x.name === clip) || (m.anims.length === 1 ? m.anims[0] : null)) : null;
    const fades = !!(visTrack && visTrack.vis && visTrack.vis.length);
    if (moves || fades || pm || um) {
      live.push({ m, mesh, items, mats, fadeMats: null, fading: false, moves, fades, pm, um, pos, uv, flags });
    }
  }

  const update = ms => {
    if (!live.length) return;
    const tick = Math.floor(ms * TICKS_PER_MS);
    const nodes = anyMoving ? mapResolver(scn, idx, clip, tick) : null;
    for (const it of live) {
      if (it.moves && nodes) {
        const w = nodes(it.m.name);
        if (w) { it.mesh.matrix.fromArray(w); it.mesh.matrixWorldNeedsUpdate = true; }
      }
      if (it.fades) {
        const v = Math.max(0, Math.min(1, modelVisibility(it.m, clip, tick)));
        it.mesh.visible = v > 0.004;
        const fading = v < 0.999;
        if (fading !== it.fading) {
          it.fading = fading;
          if (fading && !it.fadeMats) it.fadeMats = it.items.map(x => mapMaterial(x.tex, null, it.flags, sky, true));
          it.mesh.material = fading ? it.fadeMats : it.mats;
        }
        if (fading) for (const mat of it.fadeMats) mat.opacity = v;
      }
      if (it.pm) { sampleMorph(it.pm, it.m.positions, 3, 'verts', tick, it.pos.array); it.pos.needsUpdate = true; }
      if (it.um && it.uv) { sampleMorph(it.um, it.m.uvs, 2, 'uvs', tick, it.uv.array); it.uv.needsUpdate = true; }
    }
  };

  const dispose = () => {
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    for (const it of live) for (const mat of (it.fadeMats || [])) mat.dispose();
    group.traverse(o => { for (const mat of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) mat.dispose(); });
  };

  return { group, stats, update, dispose, clip, idx };
}

// Where a map effect sits: the node's own matrix, looked up in the bones, then
// the models, then the boxes of the scene.
export function nodeMatrixOf(sc, name) {
  if (!name) return null;
  const b = sc.bones.find(x => x.name === name);
  if (b) return b.matrix;
  const m = sc.models.find(x => x.name === name);
  if (m) return m.matrix;
  const x = (sc.boxes || []).find(y => y.name === name);
  return x ? x.matrix : null;
}

// Effect placement: the node's position, turned by its yaw.
export function yawPlace(M) {
  const yaw = Math.atan2(M[8], M[10]);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, M[12], M[13], M[14], 1];
}
