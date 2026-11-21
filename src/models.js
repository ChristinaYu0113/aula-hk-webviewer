import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SplatMesh, dyno } from '@sparkjsdev/spark';

export const modes = ['spc', 'hdim', 's3dgs'];
export const unlinkedColor = '#656f78';

const linkedComponents = [
  { id: 'roof', name: '屋顶', nameEn: 'Roof', color: '#5794ef' },
  { id: 'walls', name: '墙面', nameEn: 'Walls', color: '#edc64f' },
  { id: 'windows', name: '窗带', nameEn: 'Windows', color: '#61c9b4' },
];

export const scenes = {
  monument: {
    file: 'GSTestScene_gs_seg.unity',
    target: [0.66, -1.79, -0.19],
    direction: [0.45, 0.22, 1],
    distance: 4.45,
    fitWidth: 0.77,
    minDistance: 0.23,
  },
  aula: {
    file: 'AULA_Preview.unity',
    target: [0, 7.5, 0],
    direction: [-0.62, 0.45, 1],
    distance: 191,
    fitWidth: 1.03,
    minDistance: 2.8,
  },
};

const pointRgb = Float32Array.from({ length: 256 }, (_, i) =>
  new THREE.Color().setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r);

function pointSprite() {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const radius = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5);
      pixels.set([255, 255, 255, THREE.MathUtils.clamp((0.52 - radius) * size, 0, 1) * 255], offset);
    }
  }
  const result = new THREE.DataTexture(pixels, size, size);
  result.magFilter = result.minFilter = THREE.LinearFilter;
  result.needsUpdate = true;
  return result;
}

const sprite = pointSprite();

async function fetchFile(url, signal) {
  const result = await fetch(url, { signal });
  if (!result.ok) throw new Error(`${url} (${result.status})`);
  return result;
}

export function boxFrom(bounds) {
  return new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));
}

function pointMeshes(data, meta) {
  if (data.byteLength !== meta.count * 16) throw new Error('点云文件长度与清单不一致');
  const floats = new Float32Array(data);
  const bytes = new Uint8Array(data);
  return meta.parts.map(part => {
    const positions = new Float32Array(part.count * 3);
    const colors = new Float32Array(part.count * 3);
    for (let i = 0; i < part.count; i++) {
      const row = part.start + i;
      for (let axis = 0; axis < 3; axis++) {
        positions[i * 3 + axis] = floats[row * 4 + axis];
        colors[i * 3 + axis] = pointRgb[bytes[row * 16 + 12 + axis]];
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingBox();
    const material = new THREE.PointsMaterial({ size: meta.pointSize, vertexColors: true, map: sprite,
      alphaTest: 0.42, toneMapped: false });
    const object = new THREE.Points(geo, material);
    object.userData.partId = part.id;
    object.userData.component = part.component;
    return object;
  });
}

function splatTint(tint, ratio, segmentation) {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const { rgb, scales, opacity } = dyno.splitGsplat(gsplat).outputs;
    const one = dyno.dynoConst('float', 1);
    const spread = dyno.mix(one, dyno.dynoConst('float', 0.80), segmentation);
    const solid = dyno.min(one, dyno.mul(opacity, dyno.dynoConst('float', 2.2)));
    return { gsplat: dyno.combineGsplat({
      gsplat,
      rgb: dyno.mix(rgb, tint, ratio),
      scales: dyno.mul(scales, spread),
      opacity: dyno.mix(opacity, solid, segmentation),
    }) };
  });
}

async function loadSplats(root, meta, directory, signal, progress) {
  const parts = meta.parts;
  const queue = parts.values();
  const workers = Array.from({ length: Math.min(6, parts.length) }, async () => {
    for (const part of queue) {
      signal.throwIfAborted();
      const response = await fetchFile(directory + part.file, signal);
      const fileBytes = await response.arrayBuffer();
      signal.throwIfAborted();
      const tint = dyno.dynoVec3(new THREE.Vector3());
      const ratio = dyno.dynoFloat(0);
      const segmentation = dyno.dynoFloat(0);
      const mesh = new SplatMesh({ fileBytes, fileName: part.file, editable: false, enableLod: false,
        objectModifier: splatTint(tint, ratio, segmentation), minRaycastOpacity: 0.24 });
      root.add(mesh);
      mesh.userData = { partId: part.id, component: part.component, tint, ratio, segmentation, pickBox: boxFrom(part.bounds) };
      await mesh.initialized;
      progress(part.count / meta.count);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return root.children.slice();
}

function release(root) {
  root.traverse(node => {
    if (node instanceof SplatMesh) node.dispose();
    if (node.isPoints || node.isMesh) {
      node.geometry.dispose();
      node.material.dispose();
    }
  });
  root.removeFromParent();
}

function indexComponents(meshes) {
  const present = new Set();
  const linksByPart = new Map();
  for (const mesh of meshes) {
    const { partId, component } = mesh.userData;
    const link = linkedComponents.find(candidate => candidate.id === component);
    mesh.userData.link = link;
    if (link) present.add(link);
    if (!linksByPart.has(partId)) linksByPart.set(partId, new Set());
    linksByPart.get(partId).add(link);
  }
  return { components: linkedComponents.filter(link => present.has(link)), linksByPart };
}

export async function loadManifest(sceneId, mode, signal) {
  const response = await fetchFile(`models/${sceneId}/${mode}.json`, signal);
  return response.json();
}

export async function loadModel(sceneId, mode, meta, signal, progress) {
  const directory = `models/${sceneId}/`;
  const root = new THREE.Group();
  let meshes = [];
  try {
    if (mode === 's3dgs') {
      root.applyMatrix4(new THREE.Matrix4().set(...meta.transform));
      meshes = await loadSplats(root, meta, directory, signal, progress);
    } else {
      const data = await (await fetchFile(directory + meta.file, signal)).arrayBuffer();
      signal.throwIfAborted();
      if (mode === 'spc') {
        meshes = pointMeshes(data, meta);
        root.add(...meshes);
      } else {
        const { scene } = await new GLTFLoader().parseAsync(data, directory);
        root.add(scene);
        scene.traverse(object => {
          if (!object.isMesh) return;
          object.userData.originalColor = object.material.color.clone();
          object.userData.originalOpacity = object.material.opacity;
          meshes.push(object);
        });
      }
      progress(1);
    }
    signal.throwIfAborted();
    root.updateMatrixWorld(true);
    return { meta, root, meshes, ...indexComponents(meshes), dispose: () => release(root) };
  } catch (error) {
    release(root);
    throw error;
  }
}

const DISTINCT = ['#78c8ca', '#e6a572', '#9bc888', '#c5a2eb', '#ddcb76', '#e096b6', '#82aeee',
  '#f47c75', '#a9d5ad', '#8692dc', '#d49479', '#bed686', '#bc8dc7', '#69b895', '#dfb2a1', '#72badf'];

function indexedColor(i) {
  if (i < DISTINCT.length) return DISTINCT[i];
  return `hsl(${Math.round(i * 137.508) % 360}, ${58 + (i % 3) * 8}%, ${55 + (i % 4) * 6}%)`;
}

const patchTones = [0.55, 0.70, 0.43];
const patchCandidates = Array.from({ length: 108 }, (_, index) => {
  const hue = (Math.floor(index / patchTones.length) * 0.381966) % 1;
  const rgb = new THREE.Color().setHSL(hue, 0.90, patchTones[index % patchTones.length], THREE.SRGBColorSpace);
  return { css: `#${rgb.getHexString()}`, rgb: rgb.convertLinearToSRGB() };
});

function nearestColorDistance(color, palette) {
  let closest = 3;
  for (const { rgb } of palette) {
    const r = rgb.r - color.r;
    const g = rgb.g - color.g;
    const b = rgb.b - color.b;
    closest = Math.min(closest, r * r + 1.4 * g * g + b * b);
  }
  return closest;
}

function buildPatchPalette(model) {
  const boxes = new Map();
  for (const mesh of model.meshes) {
    const { partId, pickBox } = mesh.userData;
    if (!boxes.has(partId)) boxes.set(partId, new THREE.Box3());
    if (pickBox) {
      boxes.get(partId).union(pickBox);
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      boxes.get(partId).union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
    }
  }

  const colors = new Map();
  const assigned = [];
  const used = new Set();
  function assign(id, css) {
    colors.set(id, css);
    used.add(css);
    assigned.push({ box: boxes.get(id), rgb: new THREE.Color(css).convertLinearToSRGB() });
  }

  const parts = model.meta.parts;
  for (const part of parts) {
    const components = model.linksByPart.get(part.id);
    const onlyComponent = components?.size === 1 ? components.values().next().value : undefined;
    if (part.color) assign(part.id, part.color);
    else if (part.id < 0) assign(part.id, unlinkedColor);
    else if (onlyComponent?.id === 'roof') assign(part.id, onlyComponent.color);
  }

  const margin = boxFrom(model.meta.bounds).getSize(new THREE.Vector3()).length() * 0.02;
  const remaining = parts.filter(part => !colors.has(part.id)).sort((a, b) => b.count - a.count || a.id - b.id);
  for (const part of remaining) {
    const padded = boxes.get(part.id)?.clone().expandByScalar(margin);
    const neighbors = padded ? assigned.filter(entry => entry.box && padded.intersectsBox(entry.box)) : [];
    let selected;
    let highest = -1;
    for (const candidate of patchCandidates) {
      if (used.has(candidate.css)) continue;
      const local = nearestColorDistance(candidate.rgb, neighbors);
      const overall = nearestColorDistance(candidate.rgb, assigned);
      const score = local + 0.20 * overall;
      if (score > highest) {
        selected = candidate;
        highest = score;
      }
    }
    assign(part.id, selected?.css || indexedColor(colors.size));
  }
  return colors;
}

export function buildPalette(model) {
  const grouped = Object.fromEntries(['material', 'structure'].map(group => {
    const seen = new Map();
    const colors = new Map();
    for (const part of model.meta.parts) {
      const key = part[group];
      if (key && !seen.has(key)) seen.set(key, indexedColor(seen.size));
      colors.set(part.id, seen.get(key) || '#647271');
    }
    return [group, colors];
  }));
  return { patch: buildPatchPalette(model), ...grouped };
}

const accent = new THREE.Color('#ffcc7d');
const color = new THREE.Color();
const splatColor = new THREE.Color();

export function styleModel(model, colorMode, selection, isolate) {
  const colors = model.palette[colorMode];
  const patchMode = colorMode === 'patch';
  const selectionColor = patchMode ? undefined : selection?.color;
  const colorLinks = colorMode === 'structure' && model.components.length > 0;
  for (const mesh of model.meshes) {
    const { partId, link } = mesh.userData;
    const selected = selection?.partIds ? selection.partIds.has(partId) : Boolean(selection?.link && link === selection.link);
    const base = colorLinks ? (link?.color || unlinkedColor) : colors?.get(partId);
    const tint = selected ? (selectionColor || base) : base;
    const dimmed = (patchMode ? selection : selectionColor) && !selected;
    const accentSelected = !patchMode && selected && !selectionColor;
    mesh.visible = !isolate || selected;
    if (tint) color.setStyle(tint);
    if (mesh instanceof SplatMesh) {
      const weight = tint ? 1 : (selected ? 0.31 : 0);
      const rgb = splatColor.copy(tint ? color : accent);
      if (tint && accentSelected) rgb.lerp(accent, 0.28);
      rgb.convertLinearToSRGB();
      mesh.recolor.setScalar(dimmed ? (patchMode ? 0.79 : 0.50) : 1);
      mesh.userData.tint.value.set(rgb.r, rgb.g, rgb.b);
      mesh.userData.ratio.value = weight;
      mesh.userData.segmentation.value = patchMode ? 1 : 0;
      mesh.updateVersion();
    } else if (mesh.isPoints) {
      const material = mesh.material;
      const useVertex = !tint;
      if (useVertex !== material.vertexColors) {
        material.vertexColors = useVertex;
        material.needsUpdate = true;
      }
      if (tint) material.color.copy(color);
      else material.color.set(0xffffff);
      if (accentSelected) material.color.lerp(accent, 0.42);
      if (dimmed) material.color.multiplyScalar(patchMode ? 0.60 : 0.30);
      material.size = model.meta.pointSize * (patchMode ? 1.30 : 1);
    } else {
      const material = mesh.material;
      material.color.copy(tint ? color : mesh.userData.originalColor);
      if (accentSelected) material.color.lerp(accent, 0.45);
      if (dimmed) material.color.multiplyScalar(patchMode ? 0.60 : 0.30);
      material.opacity = tint ? 1 : mesh.userData.originalOpacity;
      const transparent = material.opacity < 1;
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.depthWrite = !transparent;
        material.needsUpdate = true;
      }
    }
  }
}
