// Shared by 3D, 2D and the profile; speeds describe the interval ending at each point.
export const palette = { low: '#55bdd6', high: '#ffbf69', missing: '#82909a', stopped: '#edf4ef' };
export const speedPalette = ['#ef4444', '#facc15', '#22c55e'];
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
export function rampColor(value, range, stops = [palette.low, palette.high]) {
  if (!Number.isFinite(value)) return palette.missing;
  const fraction = range[0] === range[1] ? .5 : Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])));
  const bytes = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const position = fraction * (stops.length - 1), lower = Math.min(Math.floor(position), stops.length - 2);
  const mix = position - lower, a = bytes(stops[lower]), b = bytes(stops[lower + 1]);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * mix).toString(16).padStart(2, '0')).join('');
}
export function pointColor(data, mode, index, range = valueRange(data, mode)) {
  if (mode === 'uniform') return data.routeColor || '#b9ef69';
  if (mode === 'elevation') return rampColor(data.points[index][2], range);
  const speed = speedAt(data, index);
  return speed.state === 'stopped' ? palette.stopped : rampColor(speed.value, range, speedPalette);
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
    { kind: 'start', index: 0, title: endpointTitle('start', data.startName), color: '#22c55e' },
    { kind: 'finish', index: data.points.length - 1, title: endpointTitle('finish', data.finishName), color: '#ef4444' }
  ];
}
