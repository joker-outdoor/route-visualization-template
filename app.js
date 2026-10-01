import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const $ = id => document.getElementById(id);
const color = '#b9ef69';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let D, T, points, selection = null, selectedLandmark = null, renderMap = () => {}, focus = () => {};
const chart = $('chart'), ctx = chart.getContext('2d');
const markerLabels = [];

function nearest(km) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid][3] < km) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(points[lo - 1][3] - km) < Math.abs(points[lo][3] - km) ? lo - 1 : lo;
}
function select(index, landmark = null, showCard = false) {
  selection = index; selectedLandmark = landmark;
  document.querySelectorAll('#landmark-list button').forEach((el, i) => el.classList.toggle('active', i === landmark));
  markerLabels.forEach(m => m.el.classList.toggle('active', m.landmark === landmark && landmark !== null));
  if (index !== null) {
    const p = points[index];
    $('readout').textContent = `${p[3].toFixed(2)} km · ${Math.round(p[2])} m${landmark !== null ? ' · ' + D.landmarks[landmark].name : ''}`;
    if (showCard) {
      $('point-name').textContent = landmark !== null ? D.landmarks[landmark].name : index === 0 ? '起点' : index === points.length - 1 ? '终点' : '轨迹最高点';
      $('point-detail').textContent = `${p[3].toFixed(2)} km / 海拔 ${Math.round(p[2])} m${landmark !== null ? ' · ' + D.landmarks[landmark].positionSource : ''}`;
      $('point-card').hidden = false;
    }
  } else $('readout').textContent = '滑过剖面，查看地图位置';
  drawProfile(); renderMap();
}
function chartRect() {
  const r = chart.getBoundingClientRect();
  return { w: r.width, h: r.height, l: 36, r: 9, t: 24, b: 19 };
}
function drawProfile() {
  if (!D) return;
  const g = chartRect(), dpr = Math.min(devicePixelRatio, 2);
  chart.width = Math.round(g.w * dpr); chart.height = Math.round(g.h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const e0 = Math.floor(D.stats.minM / 100) * 100, e1 = Math.max(e0 + 100, Math.ceil(D.stats.maxM / 100) * 100);
  const X = km => g.l + km / D.stats.distanceKm * (g.w - g.l - g.r);
  const Y = ele => g.t + (e1 - ele) / (e1 - e0) * (g.h - g.t - g.b);
  ctx.clearRect(0, 0, g.w, g.h); ctx.font = '9px system-ui'; ctx.textAlign = 'right';
  for (let e = e0; e <= e1; e += 100) {
    const y = Y(e); ctx.strokeStyle = '#aacad415'; ctx.beginPath(); ctx.moveTo(g.l, y); ctx.lineTo(g.w - g.r, y); ctx.stroke();
    ctx.fillStyle = '#8da7b0'; ctx.fillText(`${e}m`, g.l - 5, y + 3);
  }
  ctx.textAlign = 'center'; ctx.fillStyle = '#8da7b0';
  const step = g.w < 600 ? 4 : 2;
  for (let km = 0; km < D.stats.distanceKm; km += step) ctx.fillText(`${km}`, X(km), g.h - 3);
  ctx.textAlign = 'right'; ctx.fillText(`${D.stats.distanceKm.toFixed(1)} km`, X(D.stats.distanceKm), g.h - 3);
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(X(p[3]), Y(p[2])) : ctx.moveTo(X(p[3]), Y(p[2])));
  ctx.lineTo(X(D.stats.distanceKm), Y(e0)); ctx.lineTo(X(0), Y(e0)); ctx.closePath();
  const gradient = ctx.createLinearGradient(0, g.t, 0, g.h - g.b); gradient.addColorStop(0, '#b9ef693d'); gradient.addColorStop(1, '#b9ef6902');
  ctx.fillStyle = gradient; ctx.fill(); ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(X(p[3]), Y(p[2])) : ctx.moveTo(X(p[3]), Y(p[2])));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
  D.landmarks.forEach((landmark, i) => {
    const p = points[landmark.index], x = X(p[3]);
    ctx.strokeStyle = '#6ee1db44'; ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, Y(p[2])); ctx.stroke();
    ctx.fillStyle = '#6ee1db'; ctx.beginPath(); ctx.arc(x, Y(p[2]), 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, 12);
  });
  if (selection !== null) {
    const p = points[selection], x = X(p[3]), y = Y(p[2]);
    ctx.strokeStyle = '#ffffff88'; ctx.beginPath(); ctx.moveTo(x, g.t); ctx.lineTo(x, g.h - g.b); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }
}
function pointerProfile(e) {
  if (!D) return;
  const g = chartRect(), x = e.clientX - chart.getBoundingClientRect().left;
  const km = Math.max(0, Math.min(D.stats.distanceKm, (x - g.l) / (g.w - g.l - g.r) * D.stats.distanceKm));
  select(nearest(km));
}
chart.addEventListener('pointermove', pointerProfile);
chart.addEventListener('pointerdown', e => { chart.setPointerCapture(e.pointerId); pointerProfile(e); });
chart.addEventListener('keydown', e => {
  if (!D || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault(); const delta = e.key === 'ArrowLeft' ? -10 : 10;
  select(e.key === 'Home' ? 0 : e.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, (selection ?? 0) + delta)));
});
$('close-card').onclick = () => { $('point-card').hidden = true; };

function fillDetails() {
  document.title = `${D.title} · Joker Outdoor`;
  $('title').textContent = D.title; $('subtitle').textContent = D.subtitle;
  $('route-heading').textContent = D.routeLabel; $('map').setAttribute('aria-label', `${D.title}路线地图`);
  document.querySelector('meta[name="description"]').content = `${D.title} · GPX 路线与海拔剖面`;
  $('distance').textContent = D.stats.distanceKm.toFixed(2);
  for (const [id, key] of [['gain', 'gainM'], ['loss', 'lossM'], ['max', 'maxM']]) {
    $(id).replaceChildren(document.createTextNode(D.stats[key] === null ? '未提供' : Math.round(D.stats[key]).toLocaleString('en-US') + ' '));
    if (D.stats[key] !== null) { const unit = document.createElement('em'); unit.textContent = 'm'; $(id).append(unit); }
  }
  const minutes = D.stats.durationHours === null ? null : Math.round(D.stats.durationHours * 60);
  $('duration').textContent = minutes === null ? '未提供' : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  $('landmark-title').textContent = D.landmarkTitle;
  $('landmark-note').textContent = D.landmarkNote;
  $('data-note').textContent = `页面日期：${D.madeOn}；轨迹日期：${D.recordedOn || '未提供'}。距离按坐标测算；爬升、下降与用时：${D.statsSource}。剖面保留轨迹海拔，3D 路线贴合 DEM。`;
  $('record-date').textContent = `WGS84 · 轨迹 ${D.recordedOn || '日期未提供'}`;
  $('download').download = `${D.title}.gpx`;
  $('imagery-credit').textContent = D.imageryCredit;
  $('terrain-credit').textContent = D.terrainCredit;
  for (const [id, url] of [['imagery-credit', D.imageryUrl], ['terrain-credit', D.terrainUrl]]) {
    const link = $(id).parentElement;
    if (url) link.href = url; else { link.removeAttribute('href'); link.removeAttribute('target'); }
  }
  D.landmarks.forEach((landmark, i) => {
    const li = document.createElement('li'), b = document.createElement('button');
    const n = document.createElement('b'); n.textContent = String(i + 1);
    const name = document.createElement('span'); name.className = 'name'; name.textContent = landmark.name;
    const km = document.createElement('span'); km.className = 'km'; km.textContent = `${points[landmark.index][3].toFixed(1)} km`;
    b.append(n, name, km); b.onclick = () => { select(landmark.index, i, true); focus(points[landmark.index]); }; li.append(b); $('landmark-list').append(li);
  });
}
function sample(u, v) {
  const x = Math.max(0, Math.min(T.w - 1, u * (T.w - 1))), y = Math.max(0, Math.min(T.h - 1, v * (T.h - 1)));
  const x0 = Math.min(T.w - 2, Math.floor(x)), y0 = Math.min(T.h - 2, Math.floor(y)), fx = x - x0, fy = y - y0, i = y0 * T.w + x0;
  return T.elevations[i] * (1 - fx) * (1 - fy) + T.elevations[i + 1] * fx * (1 - fy) + T.elevations[i + T.w] * (1 - fx) * fy + T.elevations[i + T.w + 1] * fx * fy;
}
async function init3D() {
  const renderer = new THREE.WebGLRenderer({ canvas: $('map'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#0a1218');
  const extent = Math.max(D.widthKm, D.heightKm);
  const camera = new THREE.PerspectiveCamera(38, 1, extent / 10000, extent * 20);
  const controls = new OrbitControls(camera, $('map')); controls.enableDamping = true; controls.minDistance = extent * .05; controls.maxDistance = extent * 12; controls.maxPolarAngle = Math.PI * .48; controls.autoRotateSpeed = .7;
  scene.add(new THREE.HemisphereLight('#f2f7ed', '#243e48', 1.6));
  const sunlight = new THREE.DirectionalLight('#fff1d6', 1.4); sunlight.position.set(-5, 12, 8); scene.add(sunlight);
  const world = new THREE.Group(); scene.add(world);
  const base = Math.min(...T.elevations) - 100, W = D.widthKm, H = D.heightKm;
  const xyz = (u, v, height = sample(u, v)) => new THREE.Vector3((u - .5) * W, (height - base) / 1000, (v - .5) * H);
  const routePosition = p => xyz(p[4], p[5], sample(p[4], p[5]) + extent * 1.05);
  const geometry = new THREE.PlaneGeometry(W, H, T.w - 1, T.h - 1); geometry.rotateX(-Math.PI / 2);
  T.elevations.forEach((e, i) => geometry.attributes.position.setY(i, (e - base) / 1000)); geometry.computeVertexNormals();
  const texture = await new THREE.TextureLoader().loadAsync('data/satellite.jpg'); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const material = new THREE.MeshStandardMaterial({ map: texture, color: '#ffffff', roughness: 1 });
  world.add(new THREE.Mesh(geometry, material));
  // Solid sides give the terrain slab a readable edge. Top elevations use the same grid as the DEM mesh.
  const edgeMat = new THREE.MeshStandardMaterial({ color: '#20323a', roughness: 1, side: THREE.DoubleSide });
  for (const [u0, v0, u1, v1, count] of [[0, 0, 1, 0, T.w], [0, 1, 1, 1, T.w], [0, 0, 0, 1, T.h], [1, 0, 1, 1, T.h]]) {
    const positions = [], indices = [];
    for (let k = 0; k < count; k++) {
      const u = u0 + (u1 - u0) * k / (count - 1), v = v0 + (v1 - v0) * k / (count - 1), p = xyz(u, v);
      positions.push(p.x, p.y, p.z, p.x, -.1, p.z);
      if (k < count - 1) { const n = k * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(indices); g.computeVertexNormals(); world.add(new THREE.Mesh(g, edgeMat));
  }
  const vertices = points.map(routePosition);
  // Polyline segments retain GPX geometry: no spline overshoot around tight turns.
  const routeGeo = new THREE.BufferGeometry().setFromPoints(vertices);
  const routeLine = new THREE.Line(routeGeo, new THREE.LineBasicMaterial({ color, depthTest: true })); world.add(routeLine);
  const curve = new THREE.CurvePath();
  for (let i = 1; i < vertices.length; i++) if (vertices[i].distanceToSquared(vertices[i - 1]) > 0) curve.add(new THREE.LineCurve3(vertices[i - 1], vertices[i]));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(points.length * 2, 20000), extent * .0012, 5, false), new THREE.MeshBasicMaterial({ color })); world.add(tube);
  const ghost = new THREE.Line(routeGeo, new THREE.LineBasicMaterial({ color, opacity: .25, transparent: true, depthTest: false, depthWrite: false })); ghost.renderOrder = 3; world.add(ghost);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(extent * .005, 14, 10), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false })); marker.renderOrder = 5; marker.visible = false; world.add(marker);
  const labelDefinitions = D.landmarks.map((landmark, i) => ({ name: landmark.name, code: String(i + 1), p: points[landmark.index], index: landmark.index, landmark: i }));
  const maxIdx = points.reduce((best, p, i) => p[2] > points[best][2] ? i : best, 0);
  labelDefinitions.push({ name: D.startName, code: '起', p: points[0], index: 0, cls: 'endpoint' }, { name: D.finishName, code: '终', p: points.at(-1), index: points.length - 1, cls: 'endpoint' }, { name: `${Math.round(D.stats.maxM)} m`, code: '▲', p: points[maxIdx], index: maxIdx, cls: 'peak' });
  for (const item of labelDefinitions) {
    const p = routePosition(item.p), top = p.clone(); top.y += extent * .015;
    const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, top]), new THREE.LineBasicMaterial({ color: '#d4f7ef', transparent: true, opacity: .5 })); world.add(pole);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(extent * .0023, 10, 8), new THREE.MeshBasicMaterial({ color: item.landmark !== undefined ? '#6ee1db' : '#ffffff' })); dot.position.copy(p); world.add(dot);
    const el = document.createElement('button'); el.className = 'map-label ' + (item.cls || '');
    const b = document.createElement('b'); b.textContent = item.code; el.append(b, document.createTextNode(item.name));
    el.onclick = () => { select(item.index, item.landmark ?? null, true); focus(item.p); };
    $('labels').append(el); markerLabels.push({ ...item, el, top });
  }
  let transition = null, viewPreset = 'overview', narrow = innerWidth < 760;
  function setPreset(value) {
    viewPreset = value; $('overview').setAttribute('aria-pressed', String(value === 'overview')); $('top').setAttribute('aria-pressed', String(value === 'top'));
  }
  const overviewPosition = () => new THREE.Vector3(.8, 1.05, 1.3).multiplyScalar(extent * (innerWidth < 760 ? 2.3 : 1));
  const topPosition = () => new THREE.Vector3(0, extent * (innerWidth < 760 ? 3.8 : 1.8), -.01);
  function moveCamera(pos, target) {
    controls.autoRotate = false; $('rotate').setAttribute('aria-pressed', 'false');
    transition = { start: performance.now(), from: camera.position.clone(), to: pos, targetFrom: controls.target.clone(), targetTo: target };
    if (reducedMotion) { camera.position.copy(pos); controls.target.copy(target); transition = null; }
  }
  const overview = () => {
    setPreset('overview');
    moveCamera(overviewPosition(), new THREE.Vector3(0, .2, 0));
  };
  $('overview').onclick = overview;
  $('top').onclick = () => { setPreset('top'); moveCamera(topPosition(), new THREE.Vector3(0, .2, 0)); };
  $('rotate').onclick = () => { transition = null; setPreset(null); controls.autoRotate = !controls.autoRotate; $('rotate').setAttribute('aria-pressed', String(controls.autoRotate)); };
  $('ghost').onclick = () => { ghost.visible = !ghost.visible; $('ghost').setAttribute('aria-pressed', String(ghost.visible)); };
  $('texture').onclick = () => { const on = material.map === null; material.map = on ? texture : null; material.color.set(on ? '#ffffff' : '#42605a'); material.needsUpdate = true; $('texture').setAttribute('aria-pressed', String(on)); };
  function exaggerate() { world.scale.y = Number($('exag').value); $('exag-value').textContent = `${world.scale.y}×`; }
  $('exag').oninput = exaggerate; exaggerate();
  focus = p => { setPreset(null); const target = routePosition(p); target.y *= world.scale.y; moveCamera(target.clone().add(new THREE.Vector3(.27, .36, .45).multiplyScalar(extent)), target); };
  controls.addEventListener('start', () => { transition = null; setPreset(null); });
  const v = new THREE.Vector3();
  function resize() {
    const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.setViewOffset(w, h, w < 760 ? 0 : -100, w < 760 ? 190 : 80, w, h); camera.updateProjectionMatrix();
    const nowNarrow = w < 760;
    if (nowNarrow !== narrow && viewPreset) {
      transition = null; camera.position.copy(viewPreset === 'overview' ? overviewPosition() : topPosition());
      controls.target.set(0, .2, 0);
    }
    narrow = nowNarrow; drawProfile();
  }
  camera.position.copy(overviewPosition()); controls.target.set(0, .2, 0);
  addEventListener('resize', resize); resize();
  renderer.setAnimationLoop(() => {
    if (transition) {
      const t = Math.min(1, (performance.now() - transition.start) / 700), ease = t * t * (3 - 2 * t);
      camera.position.lerpVectors(transition.from, transition.to, ease); controls.target.lerpVectors(transition.targetFrom, transition.targetTo, ease);
      if (t === 1) transition = null;
    }
    if (selection !== null) { marker.visible = true; marker.position.copy(routePosition(points[selection])); } else marker.visible = false;
    controls.update(); renderer.render(scene, camera);
    const placed = [];
    for (const item of markerLabels) {
      v.copy(item.top).applyMatrix4(world.matrixWorld).project(camera);
      if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { item.el.hidden = true; continue; }
      item.el.hidden = false; let x = (v.x + 1) * innerWidth / 2, y = (1 - v.y) * innerHeight / 2;
      const w = item.el.offsetWidth, h = item.el.offsetHeight;
      if (innerWidth < 760) {
        const tools = $('tools').getBoundingClientRect();
        if (x + w / 2 > tools.left - 5 && y > tools.top && y - h < tools.bottom) x = tools.left - w / 2 - 8;
      }
      for (let n = 0; n < 12; n++) {
        const hit = placed.find(p => Math.abs(p.x - x) < (p.w + w) / 2 + 3 && Math.abs(p.y - y) < (p.h + h) / 2 + 3);
        if (!hit) break; y = hit.y - (hit.h + h) / 2 - 4;
      }
      placed.push({ x, y, w, h }); item.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`;
    }
    $('north').style.transform = `rotate(${Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z)}rad)`;
  });
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); $('status').hidden = false; $('status').textContent = '3D 图形上下文已中断，请刷新页面恢复。'; });
}
async function flatFallback() {
  // Replace the WebGL canvas: an already-used canvas cannot create a 2D context.
  const old = $('map'), canvas = old.cloneNode(false); old.replaceWith(canvas);
  const c = canvas.getContext('2d'), img = new Image(); img.src = 'data/satellite.jpg'; await img.decode();
  $('tools').hidden = true;
  document.querySelector('.profile-foot span:first-child').textContent = '卫星俯视图 · 用剖面或地标列表定位';
  renderMap = () => {
    const dpr = Math.min(devicePixelRatio, 2); canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0a1218'; c.fillRect(0, 0, innerWidth, innerHeight);
    const mobile = innerWidth < 760;
    const availableHeight = mobile ? $('side').getBoundingClientRect().top - 115 : innerHeight - 250;
    const scale = Math.min((innerWidth - (mobile ? 24 : 310)) / img.width, Math.max(50, availableHeight) / img.height);
    const w = img.width * scale, h = img.height * scale, x0 = innerWidth < 760 ? (innerWidth - w) / 2 : 310 + (innerWidth - 310 - w) / 2, y0 = mobile ? 100 : 10;
    c.drawImage(img, x0, y0, w, h); c.beginPath(); points.forEach((p, i) => { const x = x0 + p[4] * w, y = y0 + p[5] * h; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.strokeStyle = color; c.lineWidth = 2; c.stroke();
    D.landmarks.forEach((landmark, i) => { const p = points[landmark.index], x = x0 + p[4] * w, y = y0 + p[5] * h; c.fillStyle = '#6ee1db'; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); c.font = '11px system-ui'; c.fillText(`${i + 1} ${landmark.name.split('（')[0]}`, x + 7, y); });
    if (selection !== null) { const p = points[selection]; c.fillStyle = '#fff'; c.beginPath(); c.arc(x0 + p[4] * w, y0 + p[5] * h, 5, 0, 7); c.fill(); }
  };
  addEventListener('resize', () => { renderMap(); drawProfile(); }); renderMap();
}
async function main() {
  const responses = await Promise.all(['data/route.json', 'data/terrain.json'].map(async url => { const r = await fetch(url); if (!r.ok) throw new Error(`数据加载失败：${r.status}`); return r.json(); }));
  [D, T] = responses; points = D.points; fillDetails(); drawProfile();
  try {
    if (new URLSearchParams(location.search).get('view') === '2d') {
      await flatFallback(); $('status').hidden = true; return;
    }
    await init3D(); $('status').hidden = true;
  }
  catch (error) {
    console.warn('3D unavailable; switching to satellite plan view.', error);
    $('labels').replaceChildren(); markerLabels.length = 0; await flatFallback();
    $('status').textContent = '此设备暂不支持 3D，已显示卫星俯视图。'; $('status').style.top = '80px';
  }
}
main().catch(error => { console.error(error); $('status').hidden = false; $('status').textContent = '路线加载失败，请刷新页面重试。'; });
