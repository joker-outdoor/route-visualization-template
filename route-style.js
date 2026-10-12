// Shared by 3D, 2D and the profile; speeds describe the interval ending at each point.
export const palette = { low: '#55bdd6', high: '#ffbf69', missing: '#82909a', stopped: '#edf4ef' };
export function speedAt(data, index) {
  if (data.speedUnit !== 'm/s' || !data.speedSource || !Array.isArray(data.speedMps) || data.speedMps.length !== data.points.length) return { value: null, state: 'missing' };
  const value = data.speedMps[index];
  if (!Number.isFinite(value) || value < 0) return { value: null, state: data.speedState?.[index] === 'gap' ? 'gap' : 'missing' };
  const state = data.speedState?.length === data.points.length ? data.speedState[index] : null;
  return { value, state: state === 'stopped' || value === 0 ? 'stopped' : 'moving' };
}
export function valueRange(data, mode) {
  const values = mode === 'elevation' ? data.points.map(p => p[2]) : data.points.map((_, i) => speedAt(data, i)).filter(s => s.state === 'moving').map(s => s.value);
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 0];
  const actual = [Math.min(...finite), Math.max(...finite)];
  if (mode !== 'speed' || finite.length < 20) return actual;
  finite.sort((a, b) => a - b);
  const quantile = fraction => {
    const position = (finite.length - 1) * fraction, lower = Math.floor(position);
    return finite[lower] + (finite[Math.ceil(position)] - finite[lower]) * (position - lower);
  };
  const display = [quantile(.05), quantile(.95)];
  return display[0] < display[1] ? display : actual;
}
export function rampColor(value, range) {
  if (!Number.isFinite(value)) return palette.missing;
  const fraction = range[0] === range[1] ? .5 : Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])));
  const bytes = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const a = bytes(palette.low), b = bytes(palette.high);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * fraction).toString(16).padStart(2, '0')).join('');
}
export function pointColor(data, mode, index, range = valueRange(data, mode)) {
  if (mode === 'uniform') return data.routeColor || '#b9ef69';
  if (mode === 'elevation') return rampColor(data.points[index][2], range);
  const speed = speedAt(data, index);
  return speed.state === 'stopped' ? palette.stopped : rampColor(speed.value, range);
}
export function formatPace(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未提供';
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}′${String(rounded % 60).padStart(2, '0')}″/km`;
}
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未提供';
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 3600)}h ${String(Math.floor(rounded % 3600 / 60)).padStart(2, '0')}m ${String(rounded % 60).padStart(2, '0')}s`;
}
export function speedReadout(data, index) {
  const speed = speedAt(data, index);
  if (speed.state === 'gap') return '长间隔 · 速度未提供';
  if (speed.value === null) return '速度未提供';
  if (speed.state === 'stopped') return '停留';
  return `${(speed.value * 3.6).toFixed(1)} km/h · ${formatPace(1000 / speed.value)}`;
}
// Tube sampling is by world-space length, never by point count or GPX distance.
export function lengthSample(lengths, target) {
  if (target <= 0) return { index: 0, next: 0, mix: 0 };
  if (target >= lengths.at(-1)) return { index: lengths.length - 1, next: lengths.length - 1, mix: 0 };
  let lo = 0, hi = lengths.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lengths[mid] <= target) lo = mid + 1; else hi = mid; }
  const index = lo - 1;
  return { index, next: lo, mix: (target - lengths[index]) / (lengths[lo] - lengths[index]) };
}

export function segmentColors(colors, mode, index) {
  return mode === 'speed' ? [colors[index], colors[index]] : [colors[index - 1], colors[index]];
}
export function lineColorValues(colors, mode) {
  return colors.slice(1).flatMap((_, i) => segmentColors(colors, mode, i + 1).flat());
}
export function tubeColorValues(colors, samples, radialSegments, mode = 'elevation') {
  const values = [];
  for (const sample of samples) {
    const a = colors[sample.index], b = colors[sample.next];
    const rgb = mode === 'speed' ? colors[Math.max(1, sample.next)] : a.map((v, i) => v + (b[i] - v) * sample.mix);
    for (let j = 0; j <= radialSegments; j++) values.push(...rgb);
  }
  return values;
}

export function endpointTitle(kind, name) {
  const role = kind === 'start' ? '起点' : '终点';
  return typeof name === 'string' && name.trim() && name !== role ? `${role} · ${name}` : role;
}
export function routeEndpoints(data) {
  return [
    { kind: 'start', index: 0, title: endpointTitle('start', data.startName), color: '#62e3ab', shape: 'circle' },
    { kind: 'finish', index: data.points.length - 1, title: endpointTitle('finish', data.finishName), color: '#ffd166', shape: 'rect' }
  ];
}
// Move only label boxes; every leader starts at the unmodified projected track point.
export function layoutEndpointLabels(anchors, bounds, obstacles = []) {
  const overlaps = (a, b) => a.x < b.x + b.w + 6 && a.x + a.w + 6 > b.x && a.y < b.y + b.h + 6 && a.y + a.h + 6 > b.y;
  const occupied = [...obstacles, ...anchors.map(p => ({ x: p.x - 10, y: p.y - 10, w: 20, h: 20 }))];
  return anchors.map(p => {
    const left = p.x - p.w - 20, right = p.x + 20;
    const side = p.kind === 'start' ? left : right, other = p.kind === 'start' ? right : left;
    const candidates = [[side, p.y - p.h - 20], [side, p.y + 20], [p.x - p.w / 2, p.y - p.h - 34], [p.x - p.w / 2, p.y + 34], [other, p.y - p.h - 20], [other, p.y + 20]];
    for (let y = bounds.top; y + p.h <= bounds.bottom; y += p.h + 8) {
      for (const x of [p.x - p.w / 2, bounds.left, bounds.right - p.w]) candidates.push([x, y]);
    }
    if (p.w > bounds.right - bounds.left || p.h > bounds.bottom - bounds.top) return null;
    for (const [x, y] of candidates) {
      const box = { x: Math.max(bounds.left, Math.min(bounds.right - p.w, x)), y: Math.max(bounds.top, Math.min(bounds.bottom - p.h, y)), w: p.w, h: p.h };
      if (occupied.some(rect => overlaps(box, rect))) continue;
      occupied.push(box);
      return { ...box, leader: { x1: p.x, y1: p.y, x2: Math.max(box.x, Math.min(box.x + box.w, p.x)), y2: Math.max(box.y, Math.min(box.y + box.h, p.y)) } };
    }
    return null;
  });
}
