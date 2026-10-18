

import * as THREE from 'three';
import { worldPositions, assembleFull, nodeResolver, IDENT, skinModelW, resolveBoneWorlds } from './scnSkin.js';
import { morphTrackOf, sampleMorph } from './mapScene.js';

const RF_TRANSPARENT = 2, RF_CUTOUT = 4, RF_NO_CULLING = 8, RF_BILLBOARD = 16, RF_FLARE = 32, RF_NO_DEPTH_WRITE = 64, RF_DARK = 0x20000;

// Material-name token "billboard" (SCN flag bit 16): the mesh faces the camera.
export function isBillboard(m) {
  return (m.name || '').toLowerCase().includes('billboard') || !!((m.renderFlag || 0) & RF_BILLBOARD);
}

// Centre and the two largest extents of a baked quad: the sprite that stands in
// for a billboard mesh (crystal plasma's hilt eye).
export function quadFrame(positions) {
  const n = positions.length / 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const v = positions[i * 3 + k];
    if (v < lo[k]) lo[k] = v;
    if (v > hi[k]) hi[k] = v;
  }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].sort((a, b) => b - a);
  return {
    center: new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2),
    w: Math.max(0.01, ext[0]),
    h: Math.max(0.01, ext[1]),
  };
}

function spriteFrom(m, texMap, stats) {
  const it = (m.texItems && m.texItems[0]) || { name: m.texture || '' };
  let tex = it.name ? texMap.get(fileOf(it.name)) : null;
  if (tex) {
    // The quad maps a sub-rectangle of its atlas: give the sprite that window.
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    const uvs = m.uvs || [];
    for (let i = 0; i + 1 < uvs.length; i += 2) {
      u0 = Math.min(u0, uvs[i]); u1 = Math.max(u1, uvs[i]);
      v0 = Math.min(v0, uvs[i + 1]); v1 = Math.max(v1, uvs[i + 1]);
    }
    if (Number.isFinite(u0) && u1 > u0 && v1 > v0) {
      tex = tex.clone();
      tex.offset.set(u0, tex.flipY ? 1 - v1 : v0);
      tex.repeat.set(u1 - u0, v1 - v0);
      tex.needsUpdate = true;
    }
    stats.textures++;
  } else stats.untextured++;
  const n = (m.name || '').toLowerCase();
  const flag = m.renderFlag || 0;
  const cutout = !!(flag & RF_CUTOUT) || n.includes('alphatest');
  const additive = n.includes('alphablend2') || !!(flag & RF_FLARE);
  const noDepth = !!(flag & RF_NO_DEPTH_WRITE) || n.includes('nodepth');
  const mat = new THREE.SpriteMaterial({
    map: tex || null,
    color: tex ? 0xffffff : 0x8899aa,
    transparent: true,
    alphaTest: cutout ? 0.5 : 0,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: !noDepth,
  });
  mat.userData.pass = passPriority(flag, additive);
  const sprite = new THREE.Sprite(mat);
  const f = quadFrame(m.positions);
  sprite.position.copy(f.center);
  sprite.scale.set(f.w, f.h, 1);
  sprite.renderOrder = mat.userData.pass;
  sprite.name = m.name || '(unnamed)';
  sprite.userData.billboard = true;
  stats.meshes++;
  stats.tris += m.indices.length / 3;
  return sprite;
}

export const POSE_BIND = { clipA: '', clipB: '', tickA: 0, tickB: 0, blend: 0 };

const fileOf = p => p.split(/[\\/]/).pop();

async function loadAll(pieces, getTexture) {
  const wanted = new Set();
  for (const m of pieces) for (const t of (m.texItems || [])) if (t.name) wanted.add(fileOf(t.name));
  const map = new Map();
  await Promise.all([...wanted].map(async f => map.set(f, await getTexture(f))));
  return map;
}

function meshFrom(m, texMap, stats) {
  if (isBillboard(m)) return spriteFrom(m, texMap, stats);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  if (m.uvs && m.uvs.length / 2 === m.positions.length / 3) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(m.uvs), 2));   // its own copy: UV keys write into it
  }
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));

  const items = (m.texItems && m.texItems.length)
    ? m.texItems
    : [{ name: m.texture || '', faceStart: 0, faceCount: m.indices.length / 3 }];

  const mats = [];
  g.clearGroups();
  for (const it of items) {
    const count = Math.min(it.faceCount * 3, m.indices.length - it.faceStart * 3);
    if (count <= 0) continue;
    g.addGroup(it.faceStart * 3, count, mats.length);
    const tex = it.name ? texMap.get(fileOf(it.name)) : null;
    if (tex) stats.textures++; else stats.untextured++;
    mats.push(makeMaterial(tex, m.renderFlag || 0, m.name));
  }
  if (!mats.length) mats.push(makeMaterial(null, m.renderFlag || 0, m.name));

  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, mats.length === 1 ? mats[0] : mats);
  mesh.renderOrder = mats[0].userData.pass;
  mesh.name = m.name || '(unnamed)';
  stats.meshes++;
  stats.tris += m.indices.length / 3;
  return mesh;
}

function makeMaterial(tex, flag, name = '') {
  const n = name.toLowerCase();
  const cutout = !!(flag & RF_CUTOUT) || n.includes('alphatest');
  const blend = !!(flag & RF_TRANSPARENT) || !!(flag & RF_FLARE) || n.includes('alphablend');

  const additive = n.includes('alphablend2') || !!(flag & RF_FLARE);
  const dark = !!(flag & RF_DARK);
  const noCull = !!(flag & RF_NO_CULLING) || n.includes('nocull');
  const noDepth = !!(flag & RF_NO_DEPTH_WRITE) || n.includes('nodepth');
  const transparent = cutout || blend || dark;

  const mat = new THREE.MeshBasicMaterial({
    map: tex || null,

    color: tex ? 0xffffff : (additive ? 0x000000 : 0x8899aa),
    transparent,
    blending: additive ? THREE.AdditiveBlending : dark ? THREE.MultiplyBlending : THREE.NormalBlending,

    alphaTest: cutout ? 0.5 : 0,
    // The client turns depth writes off only for "nodepthwrite": a translucent
    // blade (alphablend1) still writes depth, so the additive glow shell drawn
    // after it in the same plane shows only past its edge (crystal plasma).
    depthWrite: !dark && !noDepth,
    side: noCull ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.userData.pass = passPriority(flag, additive);
  return mat;
}

function passPriority(flag, additive) {
  if (additive || (flag & RF_DARK)) return 2;
  if (flag & RF_TRANSPARENT) return 1;
  return 0;
}

export async function buildScene(scn, getTexture, pose = POSE_BIND) {
  const stats = { meshes: 0, tris: 0, textures: 0, untextured: 0 };

  const isNode = n => n !== scn.headerName && (scn.bones.some(b => b.name === n) || scn.models.some(m => m.name === n));
  const socketRoots = new Set(scn.bones
    .filter(b => !isNode(b.parent) && (b.anims || []).every(a => !(a.trans || []).length && !(a.rot || []).length && !(a.scale || []).length))
    .map(b => b.name));
  const conSocket = resolver => n => socketRoots.has(n) ? IDENT : resolver(n);

  const worldOf = conSocket(nodeResolver(scn, pose));
  // A mesh skinned to the scene's own bones (a pet, paragon's tendrils) is
  // deformed by them at the pose; worldPositions leaves it in the bind pose.
  const skinnedTo = m => !!(m.skin.length && scn.bones.length);
  const boneW0 = scn.meshes.some(skinnedTo) ? resolveBoneWorlds(scn, pose) : null;
  const pieces = scn.meshes.map(m => ({ ...m, positions: skinnedTo(m) && boneW0 ? skinModelW(m, scn, boneW0) : worldPositions(scn, m, pose, worldOf) }));
  const texMap = await loadAll(pieces, getTexture);
  const group = new THREE.Group();
  const animated = [];

  const conKeys = n => (n.anims || []).some(a => (a.trans || []).length || (a.rot || []).length || (a.scale || []).length);
  const hasSceneTRS = scn.models.some(conKeys) || (scn.bones || []).some(conKeys);
  pieces.forEach((piece, i) => {
    const mesh = meshFrom(piece, texMap, stats);
    mesh.renderOrder = mesh.renderOrder * 10000 + i;
    group.add(mesh);
    const m = scn.meshes[i];
    const morphAnim = (m.anims || []).find(a => a.morph && a.morph.length);
    const uvAttr = mesh.isSprite ? null : (mesh.geometry.attributes.uv || null);
    const uvAnim = uvAttr ? morphTrackOf(m, '', 'uvs') : null;   // "as uvani": a scrolling texture
    if (morphAnim || uvAnim || hasSceneTRS) {
      animated.push({ m, geom: mesh.isSprite ? null : mesh.geometry, sprite: mesh.isSprite ? mesh : null, morphAnim, uvAttr: uvAnim ? uvAttr : null, skinned: skinnedTo(m), base: m.positions, work: new Float32Array(m.positions.length), tmp: new Float32Array(m.positions.length) });
    }
  });

  let animate = null;
  if (animated.length) {

    animate = (tick, clip, clipOf = null) => {
      const pz = { clipA: clip || '', clipB: '', tickA: tick | 0, tickB: 0, blend: 0 };
      const wOf = (hasSceneTRS || clipOf) ? conSocket(nodeResolver(scn, pz, clipOf)) : worldOf;
      let boneW = null;
      for (const it of animated) {
        let wp;
        if (it.skinned) {   // the scene's own bones place it (a pet's body, paragon's tendrils)
          boneW = boneW || resolveBoneWorlds(scn, pz);
          wp = skinModelW(it.m, scn, boneW);
        } else {
          const local = it.morphAnim ? morphLocal(it, tick) : it.base;
          wp = worldPositions(scn, { ...it.m, positions: local }, pz, wOf, clipOf);
        }
        if (it.uvAttr) {   // UV keys: the clip's track when it has one, else the mesh's own
          const ua = morphTrackOf(it.m, clip || '', 'uvs');
          if (ua) { sampleMorph(ua, it.m.uvs, 2, 'uvs', tick, it.uvAttr.array); it.uvAttr.needsUpdate = true; }
        }
        if (it.sprite) {   // a billboard: the sprite follows the quad's centre and size
          const f = quadFrame(wp);
          it.sprite.position.copy(f.center);
          it.sprite.scale.set(f.w, f.h, 1);
          continue;
        }
        it.geom.attributes.position.array.set(wp);
        it.geom.attributes.position.needsUpdate = true;
      }
    };
  }
  // World matrices of the scene's nodes at a tick: particle systems of a .seq
  // named after a node of this scene hang from it.
  const worldOfAt = (tick, clip, clipOf = null) =>
    conSocket(nodeResolver(scn, { clipA: clip || '', clipB: '', tickA: tick | 0, tickB: 0, blend: 0 }, clipOf));
  let duration = 0;
  for (const it of animated) for (const a of (it.m.anims || [])) if (a.duration > duration) duration = a.duration;
  for (const b of (scn.bones || [])) for (const a of (b.anims || [])) if (a.duration > duration) duration = a.duration;
  return { group, stats, animate, worldOfAt, clips: scn.animNames || [], duration: duration || 0 };
}

function morphLocal(it, tick) {
  const { base, work, tmp } = it;
  const keys = it.morphAnim.morph;
  const dur = it.morphAnim.duration || 1;
  const t = ((tick % dur) + dur) % dur;
  let k = 0; while (k + 1 < keys.length && keys[k + 1].tick <= t) k++;
  const applyKey = (arr, key) => { for (const mv of key.verts) { const o = mv.index * 3; if (o + 2 < arr.length) { arr[o] = mv.pos[0]; arr[o + 1] = mv.pos[1]; arr[o + 2] = mv.pos[2]; } } };
  work.set(base); applyKey(work, keys[k]);
  const k1 = keys[k + 1];
  if (k1 && k1.tick > keys[k].tick) {
    const a = (t - keys[k].tick) / (k1.tick - keys[k].tick);
    tmp.set(base); applyKey(tmp, k1);
    for (let i = 0; i < work.length; i++) work[i] += (tmp[i] - work[i]) * a;
  }
  return work;
}

export async function buildCharacter(skel, parts, getTexture, pose = POSE_BIND, weapons = []) {
  const stats = { meshes: 0, tris: 0, textures: 0, untextured: 0 };
  const pieces = assembleFull(skel, parts, weapons, pose);
  const texMap = await loadAll(pieces, getTexture);
  const group = new THREE.Group();
  for (const m of pieces) group.add(meshFrom(m, texMap, stats));
  return { group, stats };
}

export function extentOf(group) {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return { radius: 100, center: new THREE.Vector3() };
  const s = box.getBoundingSphere(new THREE.Sphere());
  return { radius: Math.max(1, s.radius), center: s.center };
}

export function disposeGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) m.dispose();
  });
}
