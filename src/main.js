import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer } from '@sparkjsdev/spark';
import { buildPalette, loadManifest, loadModel, modes, scenes, styleModel, unlinkedColor } from './models.js';
import { copy, translatePage } from './i18n.js';
import { indexAulaMatches, isPairedMode, otherPatchMode } from './patch-matches.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const canvas = $('view');
const pin = $('pin');
const sceneSelect = $('scene');
const languageSelect = $('language');
const partsList = $('parts');
const linkedButtons = $('linked-buttons');
const filter = $('filter');
const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
const colorButtons = Array.from(document.querySelectorAll('[data-color]'));
const colorShortcuts = new Map(colorButtons.map(button => [button.getAttribute('aria-keyshortcuts').toLowerCase(), button]));
const modeLabels = { spc: 'SPC', hdim: 'HBIM', s3dgs: 'S3DGS' };
const countUnits = { spc: 'points', hdim: 'triangles', s3dgs: 'splats' };
const sceneColors = { monument: 'original', aula: 'patch' };

let sceneId = sceneSelect.value;
let mode = 's3dgs';
let locale = 'en';
let noticeKey;
let active;
let patchMatches;
let selection;
let selectedPoint;
let isolated = false;
let requestId = 0;
let sceneCache = new Map();
let sceneAbort = new AbortController();
let deviceLost = false;
languageSelect.value = locale;

function text(key) {
  return copy[locale][key];
}

function partText(part, key) {
  return locale === 'en' ? part[`${key}En`] || part[key] : part[key];
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (error) {
  console.error(error);
}

const world = new THREE.Scene();
world.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(41, 1, 0.01, 3000);
const controls = renderer ? new OrbitControls(camera, canvas) : null;
const pointer = new THREE.Vector2();
const pickBox = new THREE.Box3();
const projected = new THREE.Vector3();
const ray = new THREE.Raycaster();

let frameId = 0;
function invalidate() {
  if (renderer && !deviceLost && !frameId) frameId = requestAnimationFrame(render);
}

function render() {
  frameId = 0;
  controls.update();
  renderer.render(world, camera);
  if (!selectedPoint) return;
  projected.copy(selectedPoint).project(camera);
  pin.hidden = projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1;
  if (!pin.hidden) {
    const x = (projected.x + 1) * viewport.clientWidth / 2;
    const y = (1 - projected.y) * viewport.clientHeight / 2;
    pin.style.transform = `translate(${x}px, ${y}px)`;
  }
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewport;
  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(width, height, false);
  invalidate();
}

function resetView() {
  const settings = scenes[sceneId];
  const fit = Math.max(1, settings.fitWidth / camera.aspect);
  controls.target.fromArray(settings.target);
  camera.position.fromArray(settings.direction).setLength(settings.distance * fit).add(controls.target);
  camera.near = settings.minDistance / 30;
  camera.far = settings.distance * 22;
  controls.minDistance = settings.minDistance;
  controls.maxDistance = settings.distance * 11;
  camera.updateProjectionMatrix();
  controls.update();
  invalidate();
}

function updateNoticeText() {
  if (!noticeKey) return;
  $('notice-text').textContent = noticeKey === 'loading' ? `${text('loading')} ${modeLabels[mode]}` : text(noticeKey);
}

function setNotice(key) {
  noticeKey = key;
  const loading = key === 'loading';
  $('notice').hidden = !key;
  $('load-progress').hidden = !loading;
  if (loading) $('load-progress').removeAttribute('value');
  $('retry').hidden = !key || loading;
  viewport.setAttribute('aria-busy', String(loading));
  updateNoticeText();
}

function modeUi() {
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  $('scene-file').textContent = scenes[sceneId].file;
}

function colorUi(model) {
  const available = new Set(['original', 'patch']);
  for (const group of ['material', 'structure']) {
    if (model?.meta.parts.some(part => part[group])) available.add(group);
  }
  const hasLinks = model?.components.length > 0;
  if (hasLinks) available.add('structure');
  const requestedColor = sceneColors[sceneId];
  const shown = available.has(requestedColor) ? requestedColor : 'original';
  for (const button of colorButtons) {
    const name = button.dataset.color;
    if (name === 'structure') button.querySelector('span').textContent = text(hasLinks ? 'linkedColors' : 'structureColor');
    button.disabled = !model || !available.has(name);
    button.title = model && !available.has(name) ? text('unavailable') : '';
    button.setAttribute('aria-pressed', String(name === shown));
  }
  return shown;
}

function createField(name, value) {
  const row = document.createElement('div');
  row.className = 'field';
  const key = document.createElement('dt');
  const data = document.createElement('dd');
  key.textContent = name;
  data.textContent = value;
  row.append(key, data);
  return row;
}

function hasPatchOrigin() {
  return sceneId === 'aula' && selection?.part && isPairedMode(selection.mode);
}

function patchSelection() {
  if (!hasPatchOrigin()) return undefined;
  const { mode: origin, part } = selection;
  return { [origin]: [part], [otherPatchMode(origin)]: patchMatches?.[origin].get(part.id) || [] };
}

function selectionForView() {
  if (!active || !selection) return undefined;
  const { part, link } = selection;
  const paired = patchSelection();
  if (paired && isPairedMode(mode)) {
    const partIds = new Set(paired[mode].map(entry => entry.id));
    if (partIds.size) return { partIds, link, color: link?.color || '#ffcc7d' };
    return undefined;
  }
  if (link && active.components.includes(link)) return { link, color: link.color };
  if (part && mode === selection.mode) return { partIds: new Set([part.id]) };
  return undefined;
}

function formatPatchId(id) {
  return `#${String(id).padStart(2, '0')}`;
}

function showSelection(displayed = selectionForView()) {
  $('part-detail').hidden = !selection;
  if (!selection) return;
  const { part, link } = selection;
  const paired = patchSelection();
  const heading = paired ? (paired.spc.length === 1 ? paired.spc[0] : part) : (link || part);
  $('part-name').textContent = partText(heading, 'name');
  const swatch = $('part-swatch');
  let swatchColor = displayed?.color || link?.color;
  if (sceneColors[sceneId] === 'patch') {
    const ids = displayed?.partIds;
    swatchColor = ids?.size === 1 ? active.palette.patch.get(ids.values().next().value) : undefined;
  }
  swatch.hidden = !swatchColor;
  if (swatchColor) swatch.style.setProperty('--swatch', swatchColor);
  const fields = [];
  if (paired) {
    const names = paired.spc.map(entry => {
      const name = partText(entry, 'name');
      return entry.id < 0 ? name : `${name} (${formatPatchId(entry.id)})`;
    });
    fields.push(createField(text('spcClass'), names.join('\n') || text('pendingMatch')));
    fields.push(createField(text('scanPatch'), paired.s3dgs.map(entry => formatPatchId(entry.id)).join(', ') || text('pendingMatch')));
  } else {
    if (link) fields.push(createField(text('linkedViews'), modes.map(key => modeLabels[key]).join(' · ')));
    if (part) fields.push(createField(text('patchId'), part.id < 0 ? text('unclassified') : `#${part.id}`));
  }
  if (part) {
    for (const key of ['material', 'structure', 'decoration']) {
      if (part[key]) fields.push(createField(text(key), partText(part, key)));
    }
  }
  $('part-fields').replaceChildren(...fields);
  const isolateButton = $('isolate');
  const isolateLabel = displayed?.partIds ? (displayed.partIds.size > 1 ? 'isolatePatches' : 'isolate') : 'isolateComponent';
  isolateButton.hidden = !displayed;
  isolateButton.textContent = text(isolated ? 'showAll' : isolateLabel);
  isolateButton.setAttribute('aria-pressed', String(isolated));
}

function uniqueLink(partId) {
  const links = active?.linksByPart.get(partId);
  return links?.size === 1 ? links.values().next().value : undefined;
}

function styleActive(displayed = selectionForView()) {
  const visibleColor = colorUi(active);
  if (!active) return;
  const palette = active.palette[visibleColor];
  const legend = palette || active.palette.patch;
  const colorLinks = visibleColor === 'structure' && active.components.length > 0;
  const selectedLink = displayed?.link;
  styleModel(active, visibleColor, displayed, isolated && Boolean(displayed));
  for (const row of partsList.querySelectorAll('[data-part]')) {
    const id = Number(row.dataset.part);
    const isSelected = displayed?.partIds ? displayed.partIds.has(id) : Boolean(selectedLink && active.linksByPart.get(id)?.has(selectedLink));
    const swatch = colorLinks ? (uniqueLink(id)?.color || unlinkedColor) : legend.get(id);
    row.setAttribute('aria-pressed', String(isSelected));
    row.classList.toggle('dim', isolated && Boolean(displayed) && !isSelected);
    const highlight = visibleColor !== 'patch' && isSelected ? displayed?.color : undefined;
    row.style.setProperty('--swatch', highlight || swatch);
  }
  for (const button of linkedButtons.children) {
    button.setAttribute('aria-pressed', String(button.dataset.link === selectedLink?.id));
  }
  invalidate();
}

function applyFilter() {
  const query = filter.value.trim().toLowerCase();
  let matches = 0;
  for (const row of partsList.querySelectorAll('[data-part]')) {
    row.hidden = !row.dataset.search.includes(query);
    if (!row.hidden) matches++;
  }
  const empty = partsList.querySelector('.empty');
  if (empty) empty.hidden = Boolean(matches);
}

function partRowLabel(part) {
  const classifications = mode === 's3dgs' ? patchMatches?.s3dgs.get(part.id) : undefined;
  if (classifications?.length) return classifications.map(entry => partText(entry, 'name')).join(' / ');
  return partText(part, 'name');
}

function populateParts(model) {
  filter.value = '';
  $('filter-field').hidden = model.meta.parts.length < 16;
  $('part-count').textContent = model.meta.parts.length;
  const rows = model.meta.parts.map(part => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'part-row';
    button.dataset.part = part.id;
    const linkedNames = [...(model.linksByPart.get(part.id) || [])].filter(Boolean).flatMap(link => [link.name, link.nameEn]);
    const matchedNames = (patchMatches?.[mode]?.get(part.id) || []).flatMap(entry => [entry.name, entry.nameEn]);
    button.dataset.search = [part.id, part.name, part.nameEn, part.material, part.materialEn, part.structure,
      part.structureEn, ...linkedNames, ...matchedNames].join(' ').toLowerCase();
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    const label = document.createElement('span');
    label.className = 'part-label';
    label.textContent = partRowLabel(part);
    const id = document.createElement('span');
    id.className = 'part-id';
    id.textContent = part.id < 0 ? '—' : formatPatchId(part.id);
    button.append(swatch, label, id);
    return button;
  });
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = text('noMatches');
  empty.dataset.copy = 'noMatches';
  empty.hidden = true;
  partsList.replaceChildren(...rows, empty);
  partsList.scrollTop = 0;
}

function populateLinks(components) {
  $('linked-panel').hidden = components.length === 0;
  linkedButtons.replaceChildren(...components.map(link => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'linked-button';
    button.dataset.link = link.id;
    button.style.setProperty('--swatch', link.color);
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    const label = document.createElement('span');
    label.textContent = partText(link, 'name');
    button.append(swatch, label);
    return button;
  }));
}

function modelStatus() {
  const status = $('model-status');
  if (!active) {
    status.textContent = '';
    status.title = '';
    return;
  }
  const { count, sourceCount } = active.meta;
  const format = new Intl.NumberFormat(locale);
  status.textContent = `${format.format(count)} ${text(countUnits[mode])}`;
  status.title = sourceCount && sourceCount !== count ? text('sourceCount')(format.format(sourceCount)) : '';
}

function changeLanguage(next) {
  locale = next;
  translatePage(locale);
  updateNoticeText();
  colorUi(active);
  modelStatus();
  showSelection();
  if (active) {
    for (const [i, link] of active.components.entries()) {
      linkedButtons.children[i].lastElementChild.textContent = partText(link, 'name');
    }
    for (const row of partsList.querySelectorAll('[data-part]')) {
      row.querySelector('.part-label').textContent = partRowLabel(active.partsById.get(Number(row.dataset.part)));
    }
  }
}

function revealSelectedParts(partIds) {
  if (!partIds) return;
  const rows = Array.from(partsList.querySelectorAll('[data-part]')).filter(row => partIds.has(Number(row.dataset.part)));
  if (!rows.length) return;
  if (rows.some(row => row.hidden)) {
    filter.value = '';
    applyFilter();
  }
  const panel = partsList.getBoundingClientRect();
  const first = rows[0].getBoundingClientRect();
  const last = rows.at(-1).getBoundingClientRect();
  const bottom = last.bottom - first.top <= panel.height ? last.bottom : first.bottom;
  if (first.top < panel.top) partsList.scrollTop += first.top - panel.top;
  else if (bottom > panel.bottom) partsList.scrollTop += bottom - panel.bottom;
}

function refreshSelection(reveal = false) {
  const displayed = selectionForView();
  selectedPoint = active && selection?.mode === mode ? selection.point : undefined;
  if (!selectedPoint) pin.hidden = true;
  if (!selection) isolated = false;
  showSelection(displayed);
  styleActive(displayed);
  if (reveal) revealSelectedParts(displayed?.partIds);
}

function setSelection(next) {
  selection = next;
  refreshSelection(true);
}

function choosePart(part, point, link = uniqueLink(part?.id)) {
  setSelection(part ? { part, link, point, mode } : undefined);
}

function getSceneEntry(next) {
  const cache = sceneCache;
  let entry = cache.get(next);
  if (!entry) {
    const manifest = loadManifest(sceneId, next, sceneAbort.signal);
    entry = { manifest, fraction: 0 };
    cache.set(next, entry);
    manifest.catch(() => {
      if (cache.get(next) === entry) cache.delete(next);
    });
  }
  return entry;
}

async function viewMode(next) {
  mode = next;
  const ticket = ++requestId;
  modeUi();
  if (!renderer || deviceLost) return;
  active?.root.removeFromParent();
  active = undefined;
  if (!hasPatchOrigin()) selection = selection?.link ? { link: selection.link } : undefined;
  refreshSelection();
  populateLinks([]);
  partsList.replaceChildren();
  $('part-count').textContent = '—';
  $('filter-field').hidden = true;
  modelStatus();
  setNotice('loading');
  invalidate();

  const entry = getSceneEntry(next);
  const matchIndex = sceneId === 'aula'
    ? Promise.all([getSceneEntry('spc').manifest, getSceneEntry('s3dgs').manifest])
      .then(([spc, s3dgs]) => indexAulaMatches(spc, s3dgs), () => undefined)
    : undefined;
  if (!entry.promise) {
    const localCache = sceneCache;
    const localScene = sceneId;
    const signal = sceneAbort.signal;
    const onProgress = fraction => {
      entry.fraction += fraction;
      if (localCache === sceneCache && next === mode && !deviceLost) $('load-progress').value = entry.fraction;
    };
    entry.promise = entry.manifest.then(meta => loadModel(localScene, next, meta, signal, onProgress)).then(model => {
      entry.model = model;
      model.palette = buildPalette(model);
      model.partsById = new Map(model.meta.parts.map(part => [part.id, part]));
      return model;
    }).catch(error => {
      if (localCache.get(next) === entry) localCache.delete(next);
      throw error;
    });
  }
  if (entry.fraction > 0) $('load-progress').value = entry.fraction;

  try {
    const [model, matches] = await Promise.all([entry.promise, matchIndex]);
    if (ticket !== requestId || deviceLost) return;
    active = model;
    patchMatches = matches;
    world.add(model.root);
    populateParts(model);
    populateLinks(model.components);
    if (!hasPatchOrigin() && selection?.link && !model.components.includes(selection.link)) selection = undefined;
    modelStatus();
    setNotice();
    refreshSelection(true);
  } catch (error) {
    if (ticket !== requestId || deviceLost) return;
    console.error(error);
    setNotice('loadFailed');
  }
}

function changeScene(next) {
  if (next === sceneId) return;
  sceneAbort.abort();
  for (const entry of sceneCache.values()) entry.model?.dispose();
  sceneAbort = new AbortController();
  sceneCache = new Map();
  active = undefined;
  patchMatches = undefined;
  sceneId = next;
  setSelection(undefined);
  if (controls) resetView();
  viewMode(mode);
}

function pick(clientX, clientY) {
  if (!active) return;
  const rect = canvas.getBoundingClientRect();
  pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
  ray.setFromCamera(pointer, camera);
  ray.near = camera.near;
  ray.far = camera.far;
  const tolerance = controls.getDistance() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 6 / rect.height;
  ray.params.Points.threshold = tolerance + (active.meta.pointSize || 0) / 2;
  const candidates = active.meshes.filter(mesh => {
    if (!mesh.visible) return false;
    const bounds = mesh.userData.pickBox;
    if (bounds) return ray.ray.intersectsBox(pickBox.copy(bounds).expandByScalar(tolerance));
    return true;
  });
  const hit = ray.intersectObjects(candidates, false)[0];
  const part = hit ? active.partsById.get(hit.object.userData.partId) : undefined;
  if (part) choosePart(part, hit.point, hit.object.userData.link);
  else choosePart(undefined);
}

modeButtons.forEach(button => button.addEventListener('click', () => {
  if (button.dataset.mode !== mode || !active) viewMode(button.dataset.mode);
}));
colorButtons.forEach(button => button.addEventListener('click', () => {
  sceneColors[sceneId] = button.dataset.color;
  refreshSelection();
}));
sceneSelect.addEventListener('change', () => changeScene(sceneSelect.value));
languageSelect.addEventListener('change', () => changeLanguage(languageSelect.value));
filter.addEventListener('input', applyFilter);
partsList.addEventListener('click', event => {
  const row = event.target.closest('[data-part]');
  if (row && active) choosePart(active.partsById.get(Number(row.dataset.part)));
});
linkedButtons.addEventListener('click', event => {
  const button = event.target.closest('[data-link]');
  const link = active?.components.find(component => component.id === button?.dataset.link);
  if (link) setSelection({ link });
});
$('isolate').addEventListener('click', () => {
  isolated = !isolated;
  showSelection();
  styleActive();
});
$('clear').addEventListener('click', () => choosePart(undefined));
$('reset').addEventListener('click', () => { if (controls) resetView(); });
$('retry').addEventListener('click', () => {
  if (deviceLost || !renderer) window.location.reload();
  else viewMode(mode);
});
window.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing) return;
  if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest('input, textarea'))) return;
  if (/^[123]$/.test(event.key)) {
    event.preventDefault();
    const next = modes[Number(event.key) - 1];
    if (next !== mode || !active) viewMode(next);
  }
  const colorButton = colorShortcuts.get(event.key.toLowerCase());
  if (colorButton && !colorButton.disabled) {
    event.preventDefault();
    colorButton.click();
  }
  if (event.key === 'Home' && controls && !(event.target instanceof HTMLSelectElement)) {
    event.preventDefault();
    resetView();
  }
  if (event.key === 'Escape') choosePart(undefined);
});

if (renderer) {
  renderer.setClearColor(0x000000);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  controls.enableDamping = true;
  controls.dampingFactor = 0.14;
  controls.addEventListener('change', invalidate);
  world.add(new SparkRenderer({ renderer, onDirty: invalidate, enableLod: false, maxPixelRadius: 150 }));
  world.add(new THREE.HemisphereLight(0xf1f5ff, 0x9a9287, 2.05));
  const keyLight = new THREE.DirectionalLight(0xfff5e7, 2.0);
  keyLight.position.set(100, 170, 140);
  world.add(keyLight);

  let down;
  canvas.addEventListener('pointerdown', event => {
    if (!event.isPrimary) down = undefined;
    else if (event.button === 0) down = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointermove', event => {
    if (down?.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down = undefined;
  });
  canvas.addEventListener('pointerup', event => {
    if (down?.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 5) {
      pick(event.clientX, event.clientY);
    }
    down = undefined;
  });
  canvas.addEventListener('pointercancel', () => { down = undefined; });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    deviceLost = true;
    cancelAnimationFrame(frameId);
    setNotice('contextLost');
  });

  new ResizeObserver(resize).observe(viewport);
  resize();
  resetView();
  viewMode(mode);
} else {
  colorUi(undefined);
  setNotice('webglFailed');
}
