import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { palette, speedPalette, speedAt, valueRange, pointColor, formatPace, formatDuration, speedReadout, lengthSample, tubeColorValues, segmentColors, lineColorValues, endpointTitle, routeEndpoints } from './route-style.js';

const $ = id => document.getElementById(id);
let color = '#b9ef69', colorMode = 'uniform', pointColors = [], recolorRoute = () => {};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let D, T, points, selection = null, selectedLandmark = null, renderMap = () => {}, focus = () => {};
const chart = $('chart'), ctx = chart.getContext('2d');
const markerLabels = [];
let endpointMarkers = [];
let pauseFlight = () => {}, flightPoint = null;

function localDataUrl(filename) {
  if (typeof filename !== 'string' || /[\\?#:]/.test(filename) || !filename.split('/').every(p => p && p !== '.' && p !== '..')) throw new Error('Invalid data filename');
  return 'data/' + filename.split('/').map(encodeURIComponent).join('/');
}

function imageryManifest(data) {
  if (!data || data.version !== 1 || !Number.isInteger(data.zoom) || data.zoom < 15 || data.zoom > 18
    || typeof data.source !== 'string' || !data.source.trim() || !Array.isArray(data.patches) || !data.patches.length || data.patches.length > 256) throw new Error('Invalid imagery manifest');
  const files = new Set();
  for (const p of data.patches) {
    if (!p || typeof p.file !== 'string' || !/^imagery-detail\/[A-Za-z0-9_./-]+\.jpg$/.test(p.file) || files.has(p.file)
      || !Array.isArray(p.bounds) || p.bounds.length !== 4 || !p.bounds.every(Number.isFinite)) throw new Error('Invalid imagery patch');
    localDataUrl(p.file); files.add(p.file);
    const [u0, v0, u1, v1] = p.bounds;
    if (!(0 <= u0 && u0 < u1 && u1 <= 1 && 0 <= v0 && v0 < v1 && v1 <= 1)) throw new Error('Invalid imagery bounds');
  }
  return data;
}

function imageryDetailLayer({manifest, geometry, world, renderer, camera, controls, W, H, surfaceY, enabled}) {
  const loaded = new Map(), loading = new Map(), failed = new Set();
  const loader = new THREE.TextureLoader();
  let wanted = new Map(), active = 0, lastUpdate = -Infinity, stopped = false;
  function dispose(mesh) {
    world.remove(mesh); mesh.material.map.dispose(); mesh.material.dispose();
    // All patch meshes share the original terrain geometry, which stays alive.
  }
  function pump() {
    for (const [file, patch] of wanted) {
      if (active >= 4 || loaded.size + active >= 12) break;
      if (loaded.has(file) || loading.has(file) || failed.has(file)) continue;
      const request = {patch}; loading.set(file, request); active++;
      loader.loadAsync(localDataUrl(file)).then(texture => {
        if (stopped || !enabled() || request.patch !== patch || wanted.get(file) !== patch || loading.get(file) !== request) { texture.dispose(); return; }
        if (!texture.image || ![texture.image.width, texture.image.height].every(v => Number.isInteger(v) && v >= 1 && v <= 1024)) { texture.dispose(); failed.add(file); return; }
        const [u0, v0, u1, v1] = patch.bounds;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        // Plane UV v=1 is north, whereas manifest v=0 is north.
        texture.repeat.set(1/(u1-u0), 1/(v1-v0));
        texture.offset.set(-u0/(u1-u0), -(1-v1)/(v1-v0));
        const material = new THREE.MeshStandardMaterial({map:texture, color:'#ffffff', roughness:1,
          polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1,
          clippingPlanes:[new THREE.Plane(new THREE.Vector3(1,0,0), -((u0-.5)*W)),
            new THREE.Plane(new THREE.Vector3(-1,0,0), (u1-.5)*W),
            new THREE.Plane(new THREE.Vector3(0,0,1), -((v0-.5)*H)),
            new THREE.Plane(new THREE.Vector3(0,0,-1), (v1-.5)*H)]});
        const mesh = new THREE.Mesh(geometry, material); mesh.name = 'imagery-detail'; mesh.renderOrder = 1;
        world.add(mesh); loaded.set(file, mesh);
      }, () => { failed.add(file); }).finally(() => {
        loading.delete(file); active--; pump();
      });
    }
  }
  function clear() {
    if (!wanted.size && !loaded.size) return;
    wanted = new Map();
    // Invalidate outstanding requests even if the same patch becomes wanted again.
    for (const request of loading.values()) request.patch = null;
    for (const mesh of loaded.values()) dispose(mesh);
    loaded.clear();
  }
  return {
    clear,
    stop() { stopped = true; clear(); },
    update(now) {
      if (stopped) return;
      if (!enabled()) { clear(); return; }
      if (now-lastUpdate < 250) return;
      lastUpdate = now;
      const target = controls.target, direction = target.clone().sub(camera.position).normalize();
      const ground = surfaceY(target.x, target.z) * world.scale.y;
      if (camera.position.distanceTo(target) > 2.5 || camera.position.y-ground > 1.5) { clear(); return; }
      // Ground intersection follows the view when orbiting; ahead covers incoming flight tiles.
      const travel = direction.y < -.05 ? Math.max(0, Math.min(3, (ground-camera.position.y)/direction.y)) : 0;
      const anchor = camera.position.clone().addScaledVector(direction, travel);
      const ahead = target.clone().add(new THREE.Vector3(direction.x,0,direction.z).normalize().multiplyScalar(.6));
      const rows = manifest.patches.map(p => {
        const [u0,v0,u1,v1] = p.bounds, x0=(u0-.5)*W, x1=(u1-.5)*W, z0=(v0-.5)*H, z1=(v1-.5)*H;
        const distance = q => Math.hypot(Math.max(x0-q.x,0,q.x-x1), Math.max(z0-q.z,0,q.z-z1));
        const near = Math.min(distance(target), distance(anchor), distance(ahead));
        return {p, near, score:near + .05*Math.hypot((x0+x1)/2-target.x, (z0+z1)/2-target.z)};
      }).filter(row => row.near <= 1.2).sort((a,b) => a.score-b.score).slice(0,12);
      const next = new Map(rows.map(({p}) => [p.file,p]));
      for (const [file, request] of loading) if (!next.has(file)) request.patch = null;
      wanted = next;
      for (const [file, mesh] of loaded) if (!wanted.has(file)) { dispose(mesh); loaded.delete(file); }
      pump();
    }
  };
}

// Interpolate adjacent original points, including routes with repeated distances.
function trackSample(track, km) {
  km = Math.max(0, Math.min(track.at(-1)[3], km));
  let lo = 0, hi = track.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (track[mid][3] <= km) lo = mid + 1; else hi = mid; }
  const end = lo, start = Math.max(0, end - 1), span = track[end][3] - track[start][3];
  const t = span > 0 ? (km - track[start][3]) / span : 0;
  return track[start].map((v, i) => i === 3 ? km : v + (track[end][i] - v) * t);
}

// One non-indexed mesh: flat roof/side normals, concave roofs, independent suspended parts.
function cityGeometry(rows, project) {
  const positions = [], grounds = [], offsets = [], colors = [], roofs = [];
  const sources = new Set(['osm-height', 'osm-levels', 'osm-estimate', 'default-estimate']);
  let skipped = 0;
  for (const b of rows) {
    try {
      if (!b || !Array.isArray(b.ring) || b.ring.length < 3 || typeof b.id !== 'string' || typeof b.part !== 'boolean'
        || !Number.isFinite(b.heightM) || !Number.isFinite(b.minHeightM) || b.minHeightM < 0 || b.minHeightM >= b.heightM || b.heightM > 1000
        || !sources.has(b.heightSource)) throw new Error('Invalid building');
      if (!b.ring.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85.051129)
        || new Set(b.ring.map(p => p.join(','))).size < 3 || b.ring[0].join(',') === b.ring.at(-1).join(',')) throw new Error('Invalid ring');
      const ring = b.ring.map(p => project(...p));
      const contour = ring.map(p => new THREE.Vector2(p.x, p.z));
      if (Math.abs(THREE.ShapeUtils.area(contour)) < 1e-12) throw new Error('Empty ring');
      if (!THREE.ShapeUtils.isClockWise(contour)) { contour.reverse(); ring.reverse(); }
      const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
      if (triangles.length !== ring.length - 2) throw new Error('Incomplete roof');
      const tint = new THREE.Color(/^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : b.part ? '#b5c4cf' : '#d0cebf');
      const vertex = (i, h) => { const p = ring[i]; positions.push(p.x, 0, p.z); grounds.push(p.y); offsets.push(h / 1000); colors.push(tint.r, tint.g, tint.b); };
      for (const triangle of triangles) {
        let [a, c, d] = triangle;
        const p = ring[a], q = ring[c], r = ring[d];
        if ((q.z-p.z)*(r.x-p.x)-(q.x-p.x)*(r.z-p.z) < 0) [c, d] = [d, c];
        for (const i of [a, c, d]) vertex(i, b.heightM);
        for (const i of [a, d, c]) vertex(i, b.minHeightM);
      }
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        vertex(i, b.minHeightM); vertex(j, b.minHeightM); vertex(j, b.heightM);
        vertex(i, b.minHeightM); vertex(j, b.heightM); vertex(i, b.heightM);
      }
      roofs.push({ minX: Math.min(...ring.map(p => p.x)), maxX: Math.max(...ring.map(p => p.x)),
        minZ: Math.min(...ring.map(p => p.z)), maxZ: Math.max(...ring.map(p => p.z)),
        ground: Math.max(...ring.map(p => p.y)), height: b.heightM / 1000 });
    } catch { skipped++; }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return { geometry, grounds: new Float32Array(grounds), offsets: new Float32Array(offsets), roofs, skipped };
}

function nearest(km) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid][3] < km) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(points[lo - 1][3] - km) < Math.abs(points[lo][3] - km) ? lo - 1 : lo;
}
function select(index, landmark = null, showCard = false) {
  pauseFlight(); flightPoint = null;
  selection = index; selectedLandmark = landmark;
  document.querySelectorAll('#landmark-list button').forEach((el, i) => el.classList.toggle('active', i === landmark));
  markerLabels.forEach(m => m.el.classList.toggle('active', m.landmark === landmark && landmark !== null));
  if (index !== null) {
    const p = points[index];
    $('readout').textContent = `${p[3].toFixed(2)} km · ${Math.round(p[2])} m · ${speedReadout(D, index)}${landmark !== null ? ' · ' + D.landmarks[landmark].name : ''}`;
    if (showCard) {
      $('point-name').textContent = landmark !== null ? D.landmarks[landmark].name : index === 0 ? endpointTitle('start', D.startName) : index === points.length - 1 ? endpointTitle('finish', D.finishName) : '轨迹最高点';
      $('point-detail').textContent = `${p[3].toFixed(2)} km / 海拔 ${Math.round(p[2])} m · ${speedReadout(D, index)}${landmark !== null ? ' · ' + D.landmarks[landmark].positionSource : ''}`;
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
  const gradient = ctx.createLinearGradient(0, g.t, 0, g.h - g.b); gradient.addColorStop(0, `${color}3d`); gradient.addColorStop(1, `${color}02`);
  ctx.fillStyle = gradient; ctx.fill();
  strokeRoute(ctx, p => [X(p[3]), Y(p[2])], 1.5);
  D.landmarks.forEach((landmark, i) => {
    const p = points[landmark.index], x = X(p[3]);
    ctx.strokeStyle = '#6ee1db44'; ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, Y(p[2])); ctx.stroke();
    ctx.fillStyle = '#6ee1db'; ctx.beginPath(); ctx.arc(x, Y(p[2]), 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, 12);
  });
  if (selection !== null) {
    const p = flightPoint || points[selection], x = X(p[3]), y = Y(p[2]);
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

function createEndpointMarkers() {
  if (endpointMarkers[0]?.el.isConnected) return;
  endpointMarkers = routeEndpoints(D).map(item => {
    const el = document.createElement('button'); el.className = `endpoint-marker endpoint-${item.kind}`;
    el.style.setProperty('--endpoint-color', item.color); el.title = item.title; el.setAttribute('aria-label', item.title);
    el.onclick = () => { select(item.index, null, true); focus(points[item.index]); };
    $('labels').append(el);
    return { ...item, el };
  });
}
function renderEndpointMarkers(projected) {
  const [start, finish] = projected;
  const dx = finish.x - start.x, dy = finish.y - start.y, distance = Math.hypot(dx, dy);
  const shift = Math.max(0, (16 - distance) / 2);
  const offsetX = distance ? dx / distance * shift : shift, offsetY = distance ? dy / distance * shift : 0;
  endpointMarkers.forEach((item, i) => {
    const p = projected[i];
    item.el.hidden = p.visible === false || p.x < 0 || p.x > innerWidth || p.y < 0 || p.y > innerHeight;
    item.el.style.transform = `translate(${p.x + (i === 0 ? -offsetX : offsetX)}px,${p.y + (i === 0 ? -offsetY : offsetY)}px) translate(-50%,-50%)`;
  });
}
function strokeRoute(context, xy, width) {
  context.lineWidth = width;
  if (colorMode === 'uniform') {
    context.beginPath(); points.forEach((p, i) => { const [x, y] = xy(p); i ? context.lineTo(x, y) : context.moveTo(x, y); });
    context.strokeStyle = color; context.stroke();
  } else {
    for (let i = 1; i < points.length; i++) {
      const a = xy(points[i-1]), b = xy(points[i]);
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const gradient = context.createLinearGradient(...a, ...b);
      const [startColor, endColor] = segmentColors(pointColors, colorMode, i);
      gradient.addColorStop(0, startColor); gradient.addColorStop(1, endColor);
      context.strokeStyle = gradient; context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke();
    }
  }
  context.lineWidth = 1;
}
function setColorMode(mode) {
  colorMode = mode;
  const range = valueRange(D, mode);
  pointColors = points.map((_, i) => pointColor(D, mode, i, range));
  document.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === mode)));
  const uniform = mode === 'uniform', speed = mode === 'speed';
  $('legend-low').textContent = uniform ? '路线颜色' : speed ? `≤ ${(range[0]*3.6).toFixed(1)} km/h` : `${Math.round(range[0])} m`;
  $('legend-high').textContent = uniform ? '' : speed ? `≥ ${(range[1]*3.6).toFixed(1)} km/h` : `${Math.round(range[1])} m`;
  $('legend-ramp').style.background = uniform ? color : `linear-gradient(90deg,${(speed ? speedPalette : [palette.low, palette.high]).join(',')})`;
  $('legend-states').hidden = !speed;
  $('speed-note').hidden = !speed && !document.querySelector('[data-color="speed"]').disabled;
  $('speed-note').textContent = speed ? '推算速度 · 色阶取中间90%的速度范围；少量或常量时取实际范围' : '此路线未提供逐点速度';
  recolorRoute(); drawProfile(); renderMap();
}
function fillDetails() {
  document.title = `${D.title} · Joker Outdoor`;
  $('title').textContent = D.title; $('subtitle').textContent = D.subtitle;
  $('route-heading').textContent = D.routeLabel; $('map').setAttribute('aria-label', `${D.title}路线地图`);
  document.querySelector('meta[name="description"]').content = `${D.title} · GPX 路线与海拔剖面`;
  const activityDistance = D.activityDistanceSource && Number.isFinite(D.stats.sourceDistanceKm);
  $('distance').textContent = (activityDistance ? D.stats.sourceDistanceKm : D.stats.distanceKm).toFixed(2);
  $('distance-source').textContent = activityDistance ? D.activityDistanceSource : '轨迹测算';
  for (const [id, key] of [['gain', 'gainM'], ['loss', 'lossM'], ['max', 'maxM']]) {
    $(id).replaceChildren(document.createTextNode(D.stats[key] === null ? '未提供' : Math.round(D.stats[key]).toLocaleString('en-US') + ' '));
    if (D.stats[key] !== null) { const unit = document.createElement('em'); unit.textContent = 'm'; $(id).append(unit); }
  }
  const moving = Number.isFinite(D.stats.movingSeconds) ? D.stats.movingSeconds : null;
  $('duration-label').textContent = moving === null ? '总耗时 · 未扣暂停' : '运动时间';
  $('duration').textContent = formatDuration(moving ?? (D.stats.durationHours === null ? null : D.stats.durationHours * 3600));
  $('pace').textContent = formatPace(D.stats.avgPaceSecondsKm);
  $('pace-basis').textContent = D.stats.avgPaceSecondsKm > 0 ? `${D.stats.paceDistanceKm.toFixed(2)} km` : '未提供';
  $('pace-basis-label').textContent = D.stats.sourceDistanceKm != null ? '配速按原记录里程' : '配速按坐标里程';
  color = D.routeColor || '#b9ef69'; document.documentElement.style.setProperty('--green', color);
  const speedButton = document.querySelector('[data-color="speed"]');
  speedButton.disabled = !points.some((_, i) => speedAt(D, i).value !== null);
  speedButton.title = speedButton.disabled ? '此路线没有可用的逐点速度' : D.speedSource;
  document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => setColorMode(b.dataset.color));
  setColorMode('uniform');
  $('landmark-title').textContent = D.landmarkTitle;
  $('landmark-note').textContent = D.landmarkNote;
  $('data-note').textContent = `路线几何长度 ${D.stats.distanceKm.toFixed(2)} km，按坐标测算；运动统计：${D.statsSource}。运动计时：${D.movingTimeSource || '未提供可靠暂停统计'}。${D.stats.avgPaceSecondsKm > 0 ? '平均配速按运动时间和上述配速里程计算。' : '暂停统计不足，未计算运动配速。'}逐点速度：${D.speedSource || '未提供'}。剖面保留轨迹海拔，3D 路线贴合 DEM。`;
  $('record-date').textContent = 'WGS84';
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
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#0a1218');
  const extent = Math.max(D.widthKm, D.heightKm);
  const camera = new THREE.PerspectiveCamera(38, 1, extent / 10000, extent * 20);
  const controls = new OrbitControls(camera, $('map')); controls.enableDamping = !reducedMotion; controls.minDistance = .04; controls.maxDistance = extent * 12; controls.maxPolarAngle = Math.PI * .48; controls.autoRotateSpeed = .7;
  scene.add(new THREE.HemisphereLight('#f2f7ed', '#243e48', 1.6));
  const sunlight = new THREE.DirectionalLight('#fff1d6', 1.4); sunlight.position.set(-5, 12, 8); scene.add(sunlight);
  const world = new THREE.Group(); scene.add(world);
  const base = Math.min(...T.elevations) - 100, W = D.widthKm, H = D.heightKm;
  const xyz = (u, v, height = sample(u, v)) => new THREE.Vector3((u - .5) * W, (height - base) / 1000, (v - .5) * H);
  const routePosition = p => xyz(p[4], p[5], sample(p[4], p[5]) + (D.buildingsFile ? 2 : extent * 1.05));
  let city = null, cityMesh = null;
  const roofGrid = new Map(), cellSize = .25;
  const buildingScale = () => Number($('building-exag').value);
  function updateBuildings() {
    const scale = buildingScale();
    $('building-exag-value').textContent = `${scale}×`;
    if (!city) return;
    const position = city.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) position.setY(i, city.grounds[i] * world.scale.y + city.offsets[i] * scale);
    // flatShading derives face normals in the shader; only the bounds need updating.
    position.needsUpdate = true; city.geometry.computeBoundingSphere();
  }
  async function loadBuildings() {
    if (D.buildingsFile === undefined) return;
    $('building-note').hidden = false;
    try {
      const response = await fetch(localDataUrl(D.buildingsFile), { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.version !== 1 || !Array.isArray(data.buildings) || !data.source || !['name', 'url', 'license', 'extractedOn'].every(k => typeof data.source[k] === 'string' && data.source[k].trim())
        || !Number.isFinite(data.source.corridorMeters) || data.source.corridorMeters <= 0 || typeof data.heightNote !== 'string' || !data.heightNote.trim()) throw new Error('Invalid building data');
      const [mx0, my0, mx1, my1] = D.bounds.mercator;
      city = cityGeometry(data.buildings, (lon, lat) => {
        const mx = (lon + 180) / 360, my = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
        const u = (mx - mx0) / (mx1 - mx0), v = (my - my0) / (my1 - my0);
        if (u < -.05 || u > 1.05 || v < -.05 || v > 1.05) throw new Error('Footprint outside terrain');
        return xyz(u, v);
      });
      if (!city.roofs.length) { city.geometry.dispose(); city = null; throw new Error('No usable footprints'); }
      updateBuildings();
      cityMesh = new THREE.Mesh(city.geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85, flatShading: true }));
      cityMesh.name = 'city-buildings'; scene.add(cityMesh);
      // Cache roof bounds once; flight queries only the cells near the camera's movement.
      for (const roof of city.roofs) {
        for (let x = Math.floor((roof.minX - .035) / cellSize); x <= Math.floor((roof.maxX + .035) / cellSize); x++) {
          for (let z = Math.floor((roof.minZ - .035) / cellSize); z <= Math.floor((roof.maxZ + .035) / cellSize); z++) {
            const key = `${x},${z}`;
            if (!roofGrid.has(key)) roofGrid.set(key, []);
            roofGrid.get(key).push(roof);
          }
        }
      }
      $('building-controls').hidden = false; $('buildings').disabled = false; $('building-exag').disabled = false;
      $('buildings').setAttribute('aria-pressed', 'true');
      framingKm = -Infinity; if (flightView) projection();
      $('building-note').textContent = `建筑轮廓与部件：${data.source.name}（${data.source.license}），提取于 ${data.source.extractedOn}，沿线 ${data.source.corridorMeters} m 范围。显示 ${city.roofs.length} 项${city.skipped ? `，跳过 ${city.skipped} 项无效轮廓` : ''}。高度含来源标注及估值：楼层按 3 m/层，缺省 12 m；建筑默认夸张 1.5 倍，独立于地形。${data.heightNote} `;
      const link = document.createElement('a');
      if (/^https?:\/\//i.test(data.source.url)) { link.href = data.source.url; link.textContent = '建筑数据来源'; link.target = '_blank'; link.rel = 'noopener'; $('building-note').append(link); }
    } catch (error) {
      console.warn('Buildings unavailable:', error);
      $('building-note').textContent = '城市建筑数据不可用；地形与沿线飞行仍可使用。';
    }
  }
  $('buildings').onclick = () => { if (cityMesh) { cityMesh.visible = !cityMesh.visible; $('buildings').setAttribute('aria-pressed', String(cityMesh.visible)); } };
  $('building-exag').oninput = updateBuildings;
  // Conservative roof boxes also cover concave footprints and thin tower parts.
  function clearance(from, to) {
    let height = 0;
    const distance = Math.hypot(to.x - from.x, to.z - from.z), steps = Math.max(1, Math.ceil(distance / .02));
    const checked = new Set();
    for (let i = 0; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * i / steps, z = from.z + (to.z - from.z) * i / steps;
      height = Math.max(height, xyz(x / W + .5, z / H + .5).y * world.scale.y + .06);
      for (const roof of roofGrid.get(`${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`) || []) {
        if (checked.has(roof)) continue;
        // Use segment/expanded-box intersection, so tiny parts between samples are retained.
        let enter = 0, exit = 1;
        for (const [a, delta, min, max] of [[from.x, to.x-from.x, roof.minX-.035, roof.maxX+.035], [from.z, to.z-from.z, roof.minZ-.035, roof.maxZ+.035]]) {
          if (Math.abs(delta) < 1e-10) { if (a < min || a > max) exit = -1; }
          else { const t0 = (min-a)/delta, t1 = (max-a)/delta; enter = Math.max(enter, Math.min(t0,t1)); exit = Math.min(exit, Math.max(t0,t1)); }
        }
        if (enter <= exit) height = Math.max(height, roof.ground * world.scale.y + roof.height * buildingScale() + .065);
        checked.add(roof);
      }
    }
    return height;
  }
  const geometry = new THREE.PlaneGeometry(W, H, T.w - 1, T.h - 1); geometry.rotateX(-Math.PI / 2);
  T.elevations.forEach((e, i) => geometry.attributes.position.setY(i, (e - base) / 1000)); geometry.computeVertexNormals();
  const texture = await new THREE.TextureLoader().loadAsync('data/satellite.jpg'); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const material = new THREE.MeshStandardMaterial({ map: texture, color: '#ffffff', roughness: 1 });
  world.add(new THREE.Mesh(geometry, material));
  let detailLayer = null;
  async function loadDetailImagery() {
    if (D.imageryDetailFile === undefined) return;
    try {
      const response = await fetch(localDataUrl(D.imageryDetailFile), {signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = imageryManifest(await response.json());
      detailLayer = imageryDetailLayer({manifest, geometry, world, renderer, camera, controls, W, H,
        surfaceY:(x,z) => xyz(x/W+.5,z/H+.5).y, enabled:() => material.map !== null});
    } catch (error) { console.warn('Detail imagery unavailable; using overview:', error); }
  }
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
  const routeGeo = new THREE.BufferGeometry().setFromPoints(vertices.slice(1).flatMap((v, i) => [vertices[i], v]));
  const routeLine = new THREE.LineSegments(routeGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true })); world.add(routeLine);
  const curve = new THREE.CurvePath();
  for (let i = 1; i < vertices.length; i++) if (vertices[i].distanceToSquared(vertices[i - 1]) > 0) curve.add(new THREE.LineCurve3(vertices[i - 1], vertices[i]));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(points.length * 2, 20000), D.buildingsFile ? .003 : extent * .0012, 5, false), new THREE.MeshBasicMaterial({ vertexColors: true })); world.add(tube);
  const ghost = new THREE.LineSegments(routeGeo, new THREE.LineBasicMaterial({ vertexColors: true, opacity: .25, transparent: true, depthTest: false, depthWrite: false })); ghost.renderOrder = 3; world.add(ghost);
  const lengths = [0];
  for (let i = 1; i < vertices.length; i++) lengths.push(lengths[i-1] + vertices[i].distanceTo(vertices[i-1]));
  const tubeSamples = Array.from({ length: tube.geometry.parameters.tubularSegments + 1 }, (_, i) =>
    lengthSample(lengths, curve.getUtoTmapping(i / tube.geometry.parameters.tubularSegments) * lengths.at(-1)));
  recolorRoute = () => {
    const colors = pointColors.map(c => new THREE.Color(c).toArray());
    routeGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineColorValues(colors, colorMode), 3));
    tube.geometry.setAttribute('color', new THREE.Float32BufferAttribute(tubeColorValues(colors, tubeSamples, tube.geometry.parameters.radialSegments, colorMode), 3));
  };
  recolorRoute();
  const marker = new THREE.Mesh(new THREE.SphereGeometry(extent * .005, 14, 10), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false })); marker.name = 'route-marker'; marker.renderOrder = 5; marker.visible = false; world.add(marker);
  const labelDefinitions = D.landmarks.map((landmark, i) => ({ name: landmark.name, code: String(i + 1), p: points[landmark.index], index: landmark.index, landmark: i }));
  const maxIdx = points.reduce((best, p, i) => p[2] > points[best][2] ? i : best, 0);
  labelDefinitions.push({ name: `${Math.round(D.stats.maxM)} m`, code: '▲', p: points[maxIdx], index: maxIdx, cls: 'peak' });
  for (const item of labelDefinitions) {
    const p = routePosition(item.p), top = p.clone(); top.y += D.buildingsFile ? .025 : extent * .015;
    const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, top]), new THREE.LineBasicMaterial({ color: '#d4f7ef', transparent: true, opacity: .5 })); world.add(pole);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(D.buildingsFile ? .003 : extent * .0023, 10, 8), new THREE.MeshBasicMaterial({ color: item.landmark !== undefined ? '#6ee1db' : '#ffffff' })); dot.position.copy(p); world.add(dot);
    const el = document.createElement('button'); el.className = 'map-label ' + (item.cls || '');
    const b = document.createElement('b'); b.textContent = item.code; el.append(b, document.createTextNode(item.name));
    el.onclick = () => { select(item.index, item.landmark ?? null, true); focus(item.p); };
    $('labels').append(el); markerLabels.push({ ...item, el, top });
  }
  createEndpointMarkers();
  let transition = null, viewPreset = 'overview', narrow = innerWidth < 760;
  let playing = false, flightView = false, flightKm = 0, lastFrame = null, lastProfile = 0;
  let flightRect, framingRoof = null, framingKm = -Infinity, framingScale = '';
  const totalKm = points.at(-1)[3];
  pauseFlight = () => {
    playing = false; $('flight-play').textContent = '沿线飞行'; $('flight-play').setAttribute('aria-pressed', 'false');
    controls.enableDamping = !reducedMotion;
  };
  function projection() {
    const w = innerWidth, h = innerHeight, mobile = w < 760;
    camera.aspect = w / h;
    if (flightView) {
      const side = $('side').getBoundingClientRect(), tools = $('tools').getBoundingClientRect();
      const top = document.querySelector('header').getBoundingClientRect().bottom + 12;
      const left = mobile ? 12 : Math.min(w * .45, side.right + 16), right = mobile ? w - 12 : Math.max(left + 180, tools.left - 12);
      const bottom = Math.max(top + 100, Math.min($('profile').getBoundingClientRect().top, mobile ? Math.min(side.top, tools.top) : h) - 12);
      flightRect = { left, right, top, bottom };
      // A 60-degree lens across the unobscured map, rather than the full portrait canvas.
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(Math.PI / 6) * h / (bottom - top)));
      camera.setViewOffset(w, h, w / 2 - (left + right) / 2, h / 2 - (top + bottom) / 2, w, h);
    } else {
      camera.fov = 38; camera.setViewOffset(w, h, mobile ? 0 : -100, mobile ? 190 : 80, w, h);
    }
    camera.updateProjectionMatrix();
  }
  function skyline(current, direction) {
    const heightScale = buildingScale(), terrainScale = world.scale.y, scale = `${terrainScale}/${heightScale}`;
    if (Math.abs(flightKm - framingKm) < .03 && scale === framingScale) return framingRoof;
    framingKm = flightKm; framingScale = scale; framingRoof = null;
    const checked = new Set(), end = current.clone().addScaledVector(direction, 1.6);
    for (let x = Math.floor((Math.min(current.x, end.x) - .5) / cellSize); x <= Math.floor((Math.max(current.x, end.x) + .5) / cellSize); x++) {
      for (let z = Math.floor((Math.min(current.z, end.z) - .5) / cellSize); z <= Math.floor((Math.max(current.z, end.z) + .5) / cellSize); z++) {
        for (const roof of roofGrid.get(`${x},${z}`) || []) {
          if (checked.has(roof)) continue; checked.add(roof);
          const dx = (roof.minX + roof.maxX) / 2 - current.x, dz = (roof.minZ + roof.maxZ) / 2 - current.z;
          const along = dx * direction.x + dz * direction.z, across = Math.abs(dx * direction.z - dz * direction.x);
          if (along < -.5 || along > 1.6 || across > .45 || roof.height * heightScale < .12) continue;
          if (!framingRoof || roof.ground * terrainScale + roof.height * heightScale > framingRoof.ground * terrainScale + framingRoof.height * heightScale) framingRoof = roof;
        }
      }
    }
    return framingRoof;
  }
  function flightReadout() {
    $('flight-progress').value = String(Math.round(flightKm / totalKm * 1000));
    $('flight-distance').textContent = `${flightKm.toFixed(2)} / ${totalKm.toFixed(2)} km`;
    if (flightPoint) {
      $('readout').textContent = `${flightKm.toFixed(2)} km · ${Math.round(flightPoint[2])} m · ${speedReadout(D, selection)}`;
      drawProfile();
    }
  }
  function flightCamera(snap, dt) {
    flightPoint = trackSample(points, flightKm); selection = nearest(flightKm);
    const current = routePosition(flightPoint); current.y *= world.scale.y;
    const behind = routePosition(trackSample(points, flightKm - .05));
    const ahead = routePosition(trackSample(points, flightKm + .05));
    const direction = ahead.sub(behind); direction.y = 0;
    if (direction.lengthSq() < 1e-12) direction.set(0, 0, -1); else direction.normalize();
    const target = routePosition(trackSample(points, flightKm + .20)); target.y *= world.scale.y; target.y += .025;
    const roof = skyline(current, direction), features = [current.clone(), target.clone()];
    let rise = .24;
    if (roof) {
      const floor = roof.ground * world.scale.y, top = floor + roof.height * buildingScale();
      const lateral = new THREE.Vector3((roof.minX + roof.maxX) / 2 - current.x, 0, (roof.minZ + roof.maxZ) / 2 - current.z);
      lateral.addScaledVector(direction, -lateral.dot(direction)); target.addScaledVector(lateral, .25);
      target.y = current.y + Math.max(.025, (top - current.y) * .45);
      rise = Math.max(rise, .12 + (top - current.y) * .65);
      for (const x of [roof.minX, roof.maxX]) for (const z of [roof.minZ, roof.maxZ]) for (const y of [floor, top]) features.push(new THREE.Vector3(x, y, z));
    }
    const from = camera.position.clone(), desired = new THREE.Vector3();
    let back = innerWidth < 760 ? .40 : .32;
    for (let attempt = 0; attempt < 14; attempt++) {
      desired.copy(current).addScaledVector(direction, -back); desired.y += rise;
      desired.y = Math.max(desired.y, clearance(desired, current));
      camera.position.copy(desired); camera.lookAt(target); camera.updateMatrixWorld(true);
      const fits = features.every(point => {
        const p = point.clone().project(camera), x = (p.x + 1) * innerWidth / 2, y = (1 - p.y) * innerHeight / 2;
        const mx = (flightRect.right - flightRect.left) * .08, my = (flightRect.bottom - flightRect.top) * .08;
        return p.z > -1 && p.z < 1 && x >= flightRect.left + mx && x <= flightRect.right - mx && y >= flightRect.top + my && y <= flightRect.bottom - my;
      });
      if (fits || back >= 2.5) break;
      back = Math.min(2.5, back * 1.2);
    }
    // Check the actual smoothed movement too, rather than only the destination.
    const next = snap ? desired : from.clone().lerp(desired, 1 - Math.exp(-dt * 5));
    next.y = Math.max(next.y, clearance(snap ? next : from, next));
    camera.position.copy(next);
    if (snap) controls.target.copy(target); else controls.target.lerp(target, 1 - Math.exp(-dt * 5));
    // Remain inside normal OrbitControls angles, so pausing does not alter the pose.
    camera.position.y = Math.max(camera.position.y, controls.target.y + Math.hypot(next.x - controls.target.x, next.z - controls.target.z) * .08);
    camera.lookAt(controls.target);
  }
  function beginFlightView() {
    transition = null; controls.autoRotate = false; controls.enableDamping = false;
    flightView = true; projection();
    $('rotate').setAttribute('aria-pressed', 'false'); setPreset(null);
    selectedLandmark = null; $('point-card').hidden = true;
    document.querySelectorAll('#landmark-list button,.map-label.active').forEach(el => el.classList.remove('active'));
    // Clear any residual OrbitControls inertia before handing over the camera.
    controls.update();
  }
  $('flight-play').disabled = false; $('flight-progress').disabled = false;
  $('flight-play').onclick = () => {
    if (playing) { pauseFlight(); return; }
    const restart = flightKm >= totalKm;
    if (restart) flightKm = 0;
    const first = !flightView || !flightPoint || restart;
    beginFlightView(); playing = true; lastFrame = null;
    $('flight-play').textContent = '暂停飞行'; $('flight-play').setAttribute('aria-pressed', 'true');
    flightCamera(first || reducedMotion, 0); flightReadout();
  };
  $('flight-progress').oninput = () => {
    pauseFlight(); beginFlightView(); flightKm = Number($('flight-progress').value) / 1000 * totalKm;
    flightCamera(true, 0); flightReadout(); controls.enableDamping = !reducedMotion;
  };
  flightReadout();
  function setPreset(value) {
    viewPreset = value; $('overview').setAttribute('aria-pressed', String(value === 'overview')); $('top').setAttribute('aria-pressed', String(value === 'top'));
  }
  const overviewPosition = () => new THREE.Vector3(0, 1.05, 1.5).multiplyScalar(extent * (innerWidth < 760 ? 2.3 : 1));
  const topPosition = () => new THREE.Vector3(0, extent * (innerWidth < 760 ? 3.8 : 2.4), .01);
  function moveCamera(pos, target) {
    pauseFlight(); flightView = false; projection();
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
  $('rotate').onclick = () => { pauseFlight(); transition = null; setPreset(null); controls.autoRotate = !controls.autoRotate; $('rotate').setAttribute('aria-pressed', String(controls.autoRotate)); };
  $('ghost').onclick = () => { ghost.visible = !ghost.visible; $('ghost').setAttribute('aria-pressed', String(ghost.visible)); };
  $('texture').onclick = () => { const on = material.map === null; material.map = on ? texture : null; material.color.set(on ? '#ffffff' : '#42605a'); material.needsUpdate = true; $('texture').setAttribute('aria-pressed', String(on)); if (!on) detailLayer?.clear(); };
  function exaggerate() { world.scale.y = Number($('exag').value); $('exag-value').textContent = `${world.scale.y}×`; updateBuildings(); }
  $('exag').oninput = exaggerate; exaggerate();
  focus = p => { setPreset(null); const target = routePosition(p); target.y *= world.scale.y; moveCamera(target.clone().add(new THREE.Vector3(.27, .36, .45).multiplyScalar(extent)), target); };
  controls.addEventListener('start', () => { pauseFlight(); transition = null; setPreset(null); });
  const v = new THREE.Vector3();
  function resize() {
    const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); projection();
    const nowNarrow = w < 760;
    if (nowNarrow !== narrow && viewPreset) {
      transition = null; camera.position.copy(viewPreset === 'overview' ? overviewPosition() : topPosition());
      controls.target.set(0, .2, 0);
    }
    narrow = nowNarrow; drawProfile();
  }
  camera.position.copy(overviewPosition()); controls.target.set(0, .2, 0);
  addEventListener('resize', resize); resize();
  renderer.setAnimationLoop(now => {
    const dt = lastFrame === null ? 0 : Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
    if (playing) {
      flightKm = Math.min(totalKm, flightKm + totalKm / 180 * Number($('flight-speed').value) * dt);
      flightCamera(false, dt);
      if (now - lastProfile > 100 || flightKm === totalKm) { flightReadout(); lastProfile = now; }
      if (flightKm === totalKm) pauseFlight();
    }
    if (transition) {
      const t = Math.min(1, (performance.now() - transition.start) / 700), ease = t * t * (3 - 2 * t);
      camera.position.lerpVectors(transition.from, transition.to, ease); controls.target.lerpVectors(transition.targetFrom, transition.targetTo, ease);
      if (t === 1) transition = null;
    }
    // Paused interpolation stays visible; it never owns or constrains the camera.
    if (!playing) controls.update();
    if (selection !== null) {
      marker.visible = true; marker.position.copy(routePosition(flightPoint || points[selection]));
      if (flightPoint) {
        camera.updateMatrixWorld(true);
        const p = marker.position.clone(); p.y *= world.scale.y; p.applyMatrix4(camera.matrixWorldInverse);
        const radius = 4 * Math.max(camera.near, -p.z) / (innerHeight / 2 * camera.projectionMatrix.elements[5]);
        const scale = radius / (extent * .005); marker.scale.set(scale, scale / world.scale.y, scale);
      } else marker.scale.setScalar(1);
    } else marker.visible = false;
    detailLayer?.update(now);
    renderer.render(scene, camera);
    renderEndpointMarkers(endpointMarkers.map(item => {
      const p = routePosition(points[item.index]).applyMatrix4(world.matrixWorld).project(camera);
      return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2, visible: p.z >= -1 && p.z <= 1 };
    }));
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
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); detailLayer?.stop(); $('status').hidden = false; $('status').textContent = '3D 图形上下文已中断，请刷新页面恢复。'; });
  // Terrain is already rendering and flight is active while optional city data loads.
  if (D.buildingsFile !== undefined) { $('status').textContent = '正在加载城市建筑…'; $('status').style.top = '80px'; }
  void loadDetailImagery();
  await loadBuildings();
}
async function flatFallback() {
  pauseFlight(); $('flight-play').disabled = true; $('flight-progress').disabled = true; $('flight-speed').disabled = true;
  // Replace the WebGL canvas: an already-used canvas cannot create a 2D context.
  const old = $('map'), canvas = old.cloneNode(false); old.replaceWith(canvas);
  const c = canvas.getContext('2d'), img = new Image(); img.src = 'data/satellite.jpg'; await img.decode();
  $('tools').hidden = true; recolorRoute = () => {}; focus = () => {};
  createEndpointMarkers();
  document.querySelector('.profile-foot span:first-child').textContent = '卫星俯视图 · 用剖面或地标列表定位';
  renderMap = () => {
    const dpr = Math.min(devicePixelRatio, 2); canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0a1218'; c.fillRect(0, 0, innerWidth, innerHeight);
    const mobile = innerWidth < 760;
    const availableHeight = mobile ? $('side').getBoundingClientRect().top - 115 : innerHeight - 250;
    const scale = Math.min((innerWidth - (mobile ? 24 : 310)) / img.width, Math.max(50, availableHeight) / img.height);
    const w = img.width * scale, h = img.height * scale, x0 = innerWidth < 760 ? (innerWidth - w) / 2 : 310 + (innerWidth - 310 - w) / 2, y0 = mobile ? 100 : 10;
    c.drawImage(img, x0, y0, w, h); strokeRoute(c, p => [x0 + p[4] * w, y0 + p[5] * h], 2);
    D.landmarks.forEach((landmark, i) => { const p = points[landmark.index], x = x0 + p[4] * w, y = y0 + p[5] * h; c.fillStyle = '#6ee1db'; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); c.font = '11px system-ui'; c.fillText(`${i + 1} ${landmark.name.split('（')[0]}`, x + 7, y); });
    if (selection !== null) { const p = points[selection]; c.fillStyle = '#fff'; c.beginPath(); c.arc(x0 + p[4] * w, y0 + p[5] * h, 5, 0, 7); c.fill(); }
    renderEndpointMarkers(endpointMarkers.map(item => ({ x: x0 + points[item.index][4] * w, y: y0 + points[item.index][5] * h })));
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
