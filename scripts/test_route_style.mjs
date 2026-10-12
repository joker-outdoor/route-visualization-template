import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { palette, speedAt, valueRange, pointColor, formatPace, formatDuration, speedReadout, lengthSample, tubeColorValues, segmentColors, lineColorValues } from '../route-style.js';
const data = { points: [[0, 0, 10], [1, 1, 20], [2, 2, 30], [3, 3, 30]], routeColor: '#f35b98', speedMps: [null, 0, 2, 4], speedState: ['missing', 'stopped', 'moving', 'moving'], speedUnit: 'm/s', speedSource: 'test timestamps' };
test('uniform/elevation/speed share color endpoints, missing and stop states', () => {
  assert.equal(pointColor(data, 'uniform', 2), '#f35b98');
  assert.equal(pointColor(data, 'elevation', 0), palette.low);
  assert.equal(pointColor(data, 'elevation', 3), palette.high);
  assert.deepEqual(valueRange(data, 'speed'), [2, 4]);
  assert.equal(pointColor(data, 'speed', 0), palette.missing);
  assert.equal(pointColor(data, 'speed', 1), palette.stopped);
  assert.equal(pointColor(data, 'speed', 2), palette.low);
  assert.equal(pointColor(data, 'speed', 3), palette.high);
  assert.match(pointColor({ ...data, points: [[0, 0, 20]] }, 'elevation', 0), /^#[\da-f]{6}$/);
});
test('legacy/misaligned/unknown-unit speeds stay missing, zero remains a stop', () => {
  for (const invalid of [{ points: data.points }, { ...data, speedMps: [3] }, { ...data, speedUnit: 'unknown' }, { ...data, speedMps: [null, NaN, -2, Infinity] }]) {
    assert.equal(speedAt(invalid, 1).value, null);
    assert.equal(pointColor(invalid, 'speed', 1), palette.missing);
  }
  assert.deepEqual(speedAt(data, 1), { value: 0, state: 'stopped' });
  assert.equal(speedReadout(data, 1), '停留');
  assert.equal(speedReadout({ ...data, speedState: ['gap', 'stopped', 'moving', 'moving'] }, 0), '长间隔 · 速度未提供');
  assert.match(speedReadout(data, 2), /7.2 km\/h/);
});
test('moving summary is rounded to seconds; stationary/missing pace is never infinite', () => {
  assert.equal(formatDuration(7867.369), '2h 11m 07s');
  assert.equal(formatPace(361.6112198399695), '6′02″/km');
  assert.equal(formatPace(359.9), '6′00″/km');
  for (const missing of [null, undefined, 0, -1, Infinity, NaN]) assert.equal(formatPace(missing), '未提供');
});
test('tube colors follow unequal world-space intervals and retain line endpoint colors', () => {
  const vertices = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 3, 0), new THREE.Vector3(1, 3, 0)];
  const lengths = [0, 1, 4, 4], curve = new THREE.CurvePath();
  curve.add(new THREE.LineCurve3(vertices[0], vertices[1])); curve.add(new THREE.LineCurve3(vertices[1], vertices[2]));
  const geometry = new THREE.TubeGeometry(curve, 8, .02, 5, false);
  const samples = Array.from({ length: 9 }, (_, i) => lengthSample(lengths, curve.getUtoTmapping(i / 8) * 4));
  assert.deepEqual(samples[0], { index: 0, next: 0, mix: 0 });
  assert.deepEqual(samples.at(-1), { index: 3, next: 3, mix: 0 });
  assert.equal(samples[4].index, 1);
  const colors = [[0, 0, 1], [0, 1, 0], [1, 0, 0], [1, 0, 0]], values = tubeColorValues(colors, samples, 5);
  assert.equal(values.length, geometry.attributes.position.count * 3);
  assert.deepEqual(values.slice(0, 3), colors[0]);
  assert.deepEqual(values.slice(-3), colors.at(-1));
  for (let ring = 0; ring < samples.length; ring++) {
    const rgb = values.slice(ring * 18, ring * 18 + 3);
    for (let side = 1; side < 6; side++) assert.deepEqual(values.slice(ring * 18 + side * 3, ring * 18 + side * 3 + 3), rgb);
  }
});

test('an unknown/pause interval is colored missing throughout, never blended with a running speed', () => {
  const colors = [palette.low, palette.high, palette.missing, palette.stopped];
  assert.deepEqual(segmentColors(colors, 'speed', 2), [palette.missing, palette.missing]);
  assert.deepEqual(segmentColors(colors, 'elevation', 2), [palette.high, palette.missing]);
  const rgb = [[0,0,1],[1,0,0],[.5,.5,.5],[1,1,1]];
  assert.deepEqual(lineColorValues(rgb, 'speed').slice(6,12), [.5,.5,.5,.5,.5,.5]);
  const samples = [lengthSample([0,1,10,11],5),lengthSample([0,1,10,11],9)];
  const tube = tubeColorValues(rgb,samples,5,'speed');
  assert.deepEqual(tube.slice(0,3),[.5,.5,.5]);
  assert.deepEqual(tube.slice(-3),[.5,.5,.5]);
});

test('a speed spike saturates without compressing the normal running color range or readout', () => {
  const speeds = Array.from({ length: 100 }, (_, i) => 2 + i / 100).concat(42.6 / 3.6);
  const route = { ...data, points: speeds.map((_, i) => [i, 0, i]), speedMps: speeds, speedState: speeds.map(() => 'moving') };
  const range = valueRange(route, 'speed');
  assert.deepEqual(range, [2.05, 2.95]);
  assert.equal(pointColor(route, 'speed', 100, range), palette.high);
  assert.equal(pointColor(route, 'speed', 0, range), palette.low);
  assert.notEqual(pointColor(route, 'speed', 25, range), pointColor(route, 'speed', 75, range));
  assert.match(speedReadout(route, 100), /^42.6 km\/h/);
  assert.deepEqual(valueRange(route, 'elevation'), [0, 100]);
});
test('few speeds and a constant percentile range fall back to the actual range', () => {
  for (const speeds of [[2, 4], Array(30).fill(3), Array(30).fill(3).concat(12)]) {
    const route = { ...data, points: speeds.map(() => [0, 0, 10]), speedMps: speeds, speedState: speeds.map(() => 'moving') };
    assert.deepEqual(valueRange(route, 'speed'), [Math.min(...speeds), Math.max(...speeds)]);
    assert.match(pointColor(route, 'speed', 0), /^#[\da-f]{6}$/);
  }
});
