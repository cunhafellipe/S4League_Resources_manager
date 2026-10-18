// A weapon as the game draws it in the hand, without the hand: every piece at
// its node as the weapon's clip places it (the clip's track, else the piece's
// own track, under its parent - not the bind-relative delta of a character
// piece), the clip looping on the client clock (crystal plasma's BASE grows
// its glow sheets and turns the gear), opacity / vertex / UV keys from the
// clip or the piece's own first track, skinned pieces on the weapon's bones,
// billboards (crystal plasma's hilt eye) facing the camera on their node, and
// the weapon render states: the file's flags plus the material-name tokens,
// back faces culled unless the material says "nocull".
import * as THREE from 'three';
import { nodeIndex, mapResolver, modelVisibility, morphTrackOf, sampleMorph, TICKS_PER_MS } from './mapScene.js';
import { resolveBoneWorlds, skinModelW } from './scnSkin.js';

const RF_TRANSPARENT = 2, RF_CUTOUT = 4, RF_NO_CULLING = 8, RF_BILLBOARD = 16, RF_FLARE = 32, RF_NO_DEPTH_WRITE = 64;
const RF_ADDITIVE = 0x40000000;   // runtime: the "alphablend2" token
const fileOf = p => String(p).split(/[\\/]/).pop();

export const isBillboard = m => (m.name || '').toLowerCase().includes('billboard') || !!((m.renderFlag || 0) & RF_BILLBOARD);

function weaponFlags(m) {
  const n = (m.name || '').toLowerCase();
  let f = m.renderFlag || 0;
  if (isBillboard(m)) f |= RF_NO_CULLING;   // a camera-facing quad has no back
  if (n.includes('alphablend2')) f |= RF_ADDITIVE;
  else if (n.includes('alphablend1')) f |= RF_TRANSPARENT;
  if (n.includes('nodepthwrite')) f |= RF_NO_DEPTH_WRITE;
  if (n.includes('nocull')) f |= RF_NO_CULLING;
  return f;
}

// 2 alpha blend, 32 / alphablend2 additive, 4 alpha test, 64 no depth write;
// a fading piece (opacity key) blends without writing depth.
function materialParams(tex, flags, fading) {
  const additive = !!(flags & RF_FLARE) || !!(flags & RF_ADDITIVE);
  const transparent = !!(flags & RF_TRANSPARENT) || additive;
  const cutout = !!(flags & RF_CUTOUT) && !additive;
  const blend = !!tex && (transparent || fading);
  return {
    map: tex || null,
    transparent: blend,
    blending: blend && additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    alphaTest: !tex ? 0 : cutout ? 128 / 255 : transparent ? 8 / 255 : 0,
    depthWrite: !(flags & RF_NO_DEPTH_WRITE) && !(fading && tex),
    fog: false,
  };
}

const meshMaterial = (tex, flags, fading = false) =>
  new THREE.MeshBasicMaterial({ ...materialParams(tex, flags, fading), side: flags & RF_NO_CULLING ? THREE.DoubleSide : THREE.FrontSide });

// The quad maps a sub-rectangle of its atlas: the sprite shows that window.
function spriteMaterial(m, tex, flags, fading = false) {
  let map = tex;
  if (tex) {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    const uvs = m.uvs || [];
    for (let i = 0; i + 1 < uvs.length; i += 2) {
      u0 = Math.min(u0, uvs[i]); u1 = Math.max(u1, uvs[i]);
      v0 = Math.min(v0, uvs[i + 1]); v1 = Math.max(v1, uvs[i + 1]);
    }
    if (Number.isFinite(u0) && u1 > u0 && v1 > v0) {
      map = tex.clone();
      map.offset.set(u0, tex.flipY ? 1 - v1 : v0);
      map.repeat.set(u1 - u0, v1 - v0);
      map.needsUpdate = true;
    }
  }
  const p = materialParams(map, flags, fading);
  return new THREE.SpriteMaterial({ ...p, transparent: true });
}

// The quad in its own space. The game turns a billboard's node to the camera
// (FaceCamera): local X runs along the screen's right, local Y up, so the
// sprite takes the X and Y extents (Z for a quad laid flat) and its centre.
function quadSize(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], positions[i + k]); hi[k] = Math.max(hi[k], positions[i + k]);
  }
  const e = [0, 1, 2].map(k => hi[k] - lo[k]);
  const yAxis = e[1] > e[0] * 1e-3 ? 1 : 2;
  return { w: e[0], h: e[yAxis], yAxis, cx: (lo[0] + hi[0]) / 2, cy: (lo[yAxis] + hi[yAxis]) / 2 };
}

export async function buildWeaponScene(scn, getTexture) {
  const idx = nodeIndex(scn);
  const stats = { meshes: 0, tris: 0, textures: 0, untextured: 0 };
  const items = m => (m.texItems && m.texItems.length) ? m.texItems
    : [{ name: m.texture || '', faceStart: 0, faceCount: m.indices.length / 3 }];

  const wanted = new Set();
  for (const m of scn.meshes) for (const it of items(m)) if (it.name) wanted.add(fileOf(it.name));
  const texMap = new Map();
  await Promise.all([...wanted].map(async f => texMap.set(f, await getTexture(f))));

  const group = new THREE.Group();
  const pieces = [];
  let order = 0;
  for (const m of scn.meshes) {
    const flags = weaponFlags(m);
    const skinned = !!(m.skin.length && scn.bones.length);
    const first = items(m)[0];
    if (isBillboard(m)) {
      const tex = first.name ? texMap.get(fileOf(first.name)) || null : null;
      if (tex) stats.textures++; else stats.untextured++;
      const mat = spriteMaterial(m, tex, flags);
      const sprite = new THREE.Sprite(mat);
      sprite.name = m.name;
      sprite.renderOrder = order++;
      group.add(sprite);
      pieces.push({ m, sprite, flags, tex, mats: mat, fadeMats: null, fading: false, quad: quadSize(m.positions) });
      stats.meshes++; stats.tris += m.indices.length / 3;
      continue;
    }
    const nv = m.positions.length / 3;
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(m.positions), 3);
    g.setAttribute('position', pos);
    const uv = m.uvs && m.uvs.length === nv * 2 ? new THREE.BufferAttribute(new Float32Array(m.uvs), 2) : null;
    if (uv) g.setAttribute('uv', uv);
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const texs = [], mats = [];
    for (const it of items(m)) {
      const count = Math.min(it.faceCount * 3, m.indices.length - it.faceStart * 3);
      if (count <= 0) continue;
      const tex = it.name ? texMap.get(fileOf(it.name)) || null : null;
      if (tex) stats.textures++; else stats.untextured++;
      g.addGroup(it.faceStart * 3, count, mats.length);
      texs.push(tex);
      mats.push(meshMaterial(tex, flags));
    }
    if (!mats.length) continue;
    const mesh = new THREE.Mesh(g, mats);
    mesh.name = m.name;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order++;
    mesh.frustumCulled = false;
    group.add(mesh);
    pieces.push({ m, mesh, flags, texs, mats, fadeMats: null, fading: false, skinned, pos, uv });
    stats.meshes++; stats.tris += m.indices.length / 3;
  }

  let nodes = null;

  // ms on the client clock; clip = the weapon clip shown (its BASE by default).
  const update = (ms, clip) => {
    const tick = Math.floor(ms * TICKS_PER_MS);
    nodes = mapResolver(scn, idx, clip, tick);
    let boneW = null;
    for (const p of pieces) {
      const m = p.m;
      if (p.skinned) {
        boneW = boneW || resolveBoneWorlds(scn, { clipA: clip, clipB: '', tickA: tick, tickB: 0, blend: 0 });
        p.pos.array.set(skinModelW(m, scn, boneW));
        p.pos.needsUpdate = true;
        p.mesh.matrix.identity();
        p.mesh.matrixWorldNeedsUpdate = true;
      } else {
        const w = nodes(m.name) || m.matrix;
        if (p.sprite) {
          // Facing the camera on its node, keeping the node's scale.
          const q = p.quad;
          const sx = Math.hypot(w[0], w[1], w[2]);
          const sy = q.yAxis === 1 ? Math.hypot(w[4], w[5], w[6]) : Math.hypot(w[8], w[9], w[10]);
          p.sprite.position.set(w[12], w[13], w[14]);
          p.sprite.scale.set(Math.max(0.01, q.w * sx), Math.max(0.01, q.h * sy), 1);
          p.sprite.center.set(q.w > 0 ? 0.5 - q.cx / q.w : 0.5, q.h > 0 ? 0.5 - q.cy / q.h : 0.5);
        } else {
          p.mesh.matrix.fromArray(w);   // row-vector layout == column-major elements
          p.mesh.matrixWorldNeedsUpdate = true;
        }
      }
      // The piece's effect keys: the clip's track when it has one, else its
      // own. A skinned piece runs them too (paragon's tendrils: bones AND a
      // UV scroll); its positions come from the bones, so only the opacity
      // and UV keys apply to it.
      if (!m.anims.length) continue;
      const fxClip = m.anims.some(a => a.name === clip) ? clip : m.anims[0].name;
      const v = Math.max(0, Math.min(1, modelVisibility(m, fxClip, tick)));
      (p.sprite || p.mesh).visible = v > 0.004;
      const fading = v < 0.999;
      if (fading !== p.fading) {
        p.fading = fading;
        if (fading && !p.fadeMats) p.fadeMats = p.sprite ? spriteMaterial(m, p.tex, p.flags, true) : p.texs.map(t => meshMaterial(t, p.flags, true));
        (p.sprite || p.mesh).material = fading ? p.fadeMats : p.mats;
      }
      if (fading) for (const mat of [].concat(p.fadeMats)) mat.opacity = v;
      if (p.mesh) {
        const pm = p.skinned ? null : morphTrackOf(m, fxClip, 'verts');
        if (pm && pm.morph.some(k => k.verts.length)) { sampleMorph(pm, m.positions, 3, 'verts', tick, p.pos.array); p.pos.needsUpdate = true; }
        const um = p.uv ? morphTrackOf(m, fxClip, 'uvs') : null;
        if (um) { sampleMorph(um, m.uvs, 2, 'uvs', tick, p.uv.array); p.uv.needsUpdate = true; }
      }
    }
  };

  // World of a node of the weapon at the last update (effects hang from it).
  const nodeWorld = name => (nodes ? nodes(name) : null);

  const dispose = () => group.traverse(o => {
    if (o.geometry && !o.isSprite) o.geometry.dispose();
    for (const mat of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) mat.dispose();
  });

  return { group, stats, update, nodeWorld, dispose, clips: scn.animNames || [] };
}
