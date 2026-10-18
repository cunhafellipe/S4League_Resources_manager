'use strict';

const { mat4Mul, sampleNode, boneWorldByName, boneWorldByNameW, skinModelW, resolveBoneWorlds } = require('./scn_skin');

function applyMatrix(pos, M){
  const out = new Float32Array(pos.length);
  for(let i = 0; i < pos.length; i += 3){
    const x = pos[i], y = pos[i+1], z = pos[i+2];
    out[i]   = x*M[0]+y*M[4]+z*M[8]+M[12];
    out[i+1] = x*M[1]+y*M[5]+z*M[9]+M[13];
    out[i+2] = x*M[2]+y*M[6]+z*M[10]+M[14];
  }
  return out;
}

// El padre de un modelo NO siempre es un hueso: puede ser OTRO MODELO de la
// misma escena (la hoja de un arma cuelga del mango, un accesorio cuelga de
// otro accesorio). boneWorldByName solo busca en scene.bones, asi que esos
// casos caian directo a sampleNode() (bind propio, sin la transformacion del
// padre) y la pieza quedaba despegada. Se encadena por nombre de modelo antes
// de intentar hueso.
function modelWorld(scene, name, pose, cache, depth){
  depth = depth || 0;
  if(!name || depth > 16) return null;          // corta ciclos
  if(cache.has(name)) return cache.get(name);
  const m = scene.models.find(x => x.name === name);
  if(!m){ cache.set(name, null); return null; }
  const parentW = m.parent ? modelWorld(scene, m.parent, pose, cache, depth + 1) : null;
  const w = parentW ? mat4Mul(m.matrix, parentW) : m.matrix;
  cache.set(name, w);
  return w;
}

// A piece skinned to bones of its own that the skeleton lacks (the default
// hair's Hair_Bone_Dummy): each such bone hangs from its skeleton parent, else
// from the head, the way a rigid hair hangs that same dummy off the head. Left
// out of the table they kept the bind pose and the hair floated off the body.
function skinWithPartBones(m, skel, skelWorld, scene){
  const extra = [], extraWorld = [];
  const head = boneWorldByNameW(skel, 'Bip01 Head', skelWorld);
  for(const sb of m.skin){
    if(skel.bones.some(b => b.name === sb.name) || extra.some(b => b.name === sb.name)) continue;
    const b = scene.bones.find(x => x.name === sb.name);
    if(!b) continue;
    const parentW = boneWorldByNameW(skel, b.parent, skelWorld) || head;
    extra.push(b);
    extraWorld.push(parentW ? mat4Mul(b.matrix, parentW) : b.matrix);
  }
  if(!extra.length) return skinModelW(m, skel, skelWorld);
  return skinModelW(m, { bones: [...skel.bones, ...extra] }, [...skelWorld, ...extraWorld]);
}

function gatherScene(skel, skelWorld, scene, pose, pieces){
  for(const m of scene.models){
    if(!m.positions.length || !m.indices.length) continue;
    let positions;
    if(m.skin.length){
      positions = skinWithPartBones(m, skel, skelWorld, scene);
    } else {
      const dummy = m.parent ? boneWorldByName(scene, m.parent, pose) : null;
      const head = boneWorldByNameW(skel, 'Bip01 Head', skelWorld);
      let world;
      if(dummy && head) world = mat4Mul(mat4Mul(m.matrix, dummy), head);
      else if(dummy)    world = mat4Mul(m.matrix, dummy);
      else {
        // Its parent is not in the piece's own scene: a bone of the skeleton,
        // else the head. Loose hair / face pieces stayed where the bind pose
        // put them while the body moved.
        const bone = m.parent ? boneWorldByNameW(skel, m.parent, skelWorld) : null;
        if(bone)      world = mat4Mul(m.matrix, bone);
        else if(head) world = mat4Mul(m.matrix, head);
        else          world = sampleNode(m, pose.tickA);
      }
      positions = applyMatrix(m.positions, world);
    }
    pieces.push({ name: m.name, positions, indices: m.indices, uvs: m.uvs, texture: m.texture, dir: scene.dir || '', renderFlag: m.renderFlag || 0 });
  }
}

// An accessory hangs from one skeleton bone (the item's to_node_parent; the
// head when it names none): its pieces keep their place under their own dummy.
function gatherAccessory(skel, skelWorld, scene, targetBone, pose, pieces){
  const modelCache = new Map();
  const boneW = boneWorldByNameW(skel, targetBone || 'Bip01 Head', skelWorld) || boneWorldByNameW(skel, 'Bip01 Head', skelWorld);
  for(const m of scene.models){
    if(!m.positions.length || !m.indices.length) continue;
    let positions;
    if(m.skin.length) positions = skinModelW(m, skel, skelWorld);
    else {
      const dummy = m.parent ? (modelWorld(scene, m.parent, pose, modelCache) || boneWorldByName(scene, m.parent, pose)) : null;
      const local = dummy ? mat4Mul(m.matrix, dummy) : m.matrix;
      positions = applyMatrix(m.positions, boneW ? mat4Mul(local, boneW) : local);
    }
    pieces.push({ name: m.name, positions, indices: m.indices, uvs: m.uvs, texture: m.texture, dir: scene.dir || '', renderFlag: m.renderFlag || 0 });
  }
}

function assembleCharacter(skel, parts, pose, accessories){
  const skelWorld = resolveBoneWorlds(skel, pose);
  const pieces = [];
  for(const part of parts) gatherScene(skel, skelWorld, part, pose, pieces);
  for(const acc of (accessories || [])) gatherAccessory(skel, skelWorld, acc.scene, acc.bone, pose, pieces);
  return pieces;
}

module.exports = { assembleCharacter, gatherScene, gatherAccessory, applyMatrix };
