import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three.module.js';
import { landmarkPoint } from '../route-style.js';
import * as story from '../video-story.js';

const { createCameraTrack, createVideoTimeline, resolveVideoStops, sampleVideoTimeline } = story;
const route = JSON.parse(await readFile(new URL('../data/route.json', import.meta.url)));
const terrain = JSON.parse(await readFile(new URL('../data/terrain.json', import.meta.url)));
const script = (await readFile(new URL('../video.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');

test('photo timeline orders stops and holds exact progress through fades, including endpoints', () => {
  const timeline = createVideoTimeline({
    distanceKm: 10, duration: 30,
    stops: [{ km: 10 }, { km: 4 }, { km: 0 }, { km: 4 }],
  });
  const sample = time => sampleVideoTimeline(timeline, time);
  assert.deepEqual(sample(-1), { km: 0, phase: 'overview', travelView: 0 });
  assert.deepEqual(sample(31), { km: 10, phase: 'outro', travelView: 0 });
  const photos = timeline.segments.filter(segment => segment.phase === 'photo');
  assert.deepEqual(photos.map(({ photo }) => photo.index), [2, 1, 3, 0]);
  for (const { start, end, from, photo } of photos) {
    assert.equal(sample(start).photoOpacity, 0);
    assert.ok(Math.abs(sample(start + .25).photoOpacity - .5) < 1e-12);
    assert.equal(sample(start + .5).photoOpacity, 1);
    assert.equal(sample(end - .5).photoOpacity, 1);
    assert.ok(Math.abs(sample(end - .25).photoOpacity - .5) < 1e-12);
    assert.equal(sample(end).km, from);
    assert.deepEqual(sample(start + 1), { km: from, phase: 'photo', travelView: 1, photoIndex: photo.index, photoOpacity: 1 });
  }
  const plain = createVideoTimeline({ distanceKm: 10, duration: 2 });
  assert.equal(sampleVideoTimeline(plain, 1).phase, 'travel');
  assert.equal(sampleVideoTimeline(plain, 2).km, 10);
});

test('invalid photo positions, paths and durations give specific errors', () => {
  const resolve = stop => resolveVideoStops({ stops: [stop] }, route.landmarks, route.points, route.stats.distanceKm);
  const src = 'photos/view.jpg';
  for (const invalid of ['https://a.test/a.jpg', '../a.jpg', '/a.jpg', 'data/%2e/a.jpg', 'data/a.json']) {
    assert.throws(() => resolve({ km: 2, src: invalid }), /src/);
  }
  assert.throws(() => resolve({ src }), /km 或 landmark/);
  assert.throws(() => resolve({ km: 2, src, landmark: 'missing' }), /km 或 landmark/);
  assert.throws(() => resolve({ src, landmark: 'missing' }), /唯一匹配/);
  const mark = { name: 'end', index: 1 };
  const points = [[0, 0, 0, 0], [0, 0, 0, 10.0000001]];
  const video = { stops: [{ landmark: 'end', src }] };
  assert.throws(() => resolveVideoStops(video, [mark, mark], points, 10), /唯一匹配/);
  assert.deepEqual(resolveVideoStops(video, [mark], points, 10), [{ landmark: 'end', name: 'end', src, km: 10 }]);

  const schedule = (stop, duration = 10) => createVideoTimeline({ distanceKm: 10, duration, stops: [stop] });
  for (const km of [null, -1, 11, '1']) assert.throws(() => schedule({ km }), /\.km/);
  assert.throws(() => schedule({ km: 4, holdSeconds: 0 }), /holdSeconds/);
  assert.throws(() => schedule({ km: 4, transitionSeconds: -1 }), /transitionSeconds/);
  assert.throws(() => schedule({ km: 4 }, 2), /至少需要 6 秒/);
  assert.equal(sampleVideoTimeline(schedule({ km: 4, transitionSeconds: 0 }), 5).photoOpacity, 1);
});

test('distance-sampled camera turns continuously through a right angle and an exact reversal', () => {
  const points = [0, 1, 2, 3].map(km => [0, 0, 0, km]);
  const vertices = [[0, 0], [0, 1], [1, 1], [0, 1]].map(([x, z]) => ({ x, z }));
  const camera = createCameraTrack(points, vertices, 3);
  assert.equal(camera(0).angle, 0);
  assert.ok(Math.abs(Math.sin(camera(3).angle) + 1) < 1e-12);
  assert.ok(camera(1).pullback > 0);
  assert.equal(camera(2).pullback, 1);
  assert.equal(camera(.5).pullback, 0);
  for (let i = 1; i <= 3000; i++) {
    assert.ok(Math.abs(camera(i / 1000).angle - camera((i - 1) / 1000).angle) < .03);
  }
});

// Run the production frame function with Three geometry, a CPU renderer and test DOM.
async function videoFixture({ viewport, search = '?capture&duration=8', stops, decode, legacy = false }) {
  const data = { ...route };
  if (stops !== undefined) data.video = { stops };
  if (legacy) {
    data.lakes = data.landmarks;
    delete data.landmarks;
  }
  const [innerWidth, innerHeight] = viewport;
  const elements = new Map();
  const context2d = new Proxy({}, { get: (_, key) => key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {} });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, offsetWidth: 96, offsetHeight: 33, clientWidth: innerWidth * .9, clientHeight: innerHeight * .11,
      classList: { toggle() {} }, append() {}, replaceChildren(node) { this.firstChild = node; }, getContext: () => context2d,
    });
    return elements.get(id);
  };
  const rendered = {};
  class WebGLRenderer {
    capabilities = { getMaxAnisotropy: () => 1 };
    setSize() {}
    setPixelRatio() {}
    render(scene, camera) { Object.assign(rendered, {scene, camera}); }
  }
  class Image {
    decode() { return decode(this.src); }
  }
  const window = {};
  const done = vm.runInNewContext(`(async () => {${script}})()`, {
    ...story, window, Image, innerWidth, innerHeight, landmarkPoint,
    THREE: { ...THREE, WebGLRenderer, TextureLoader: class { async loadAsync() { return new THREE.Texture(); } } },
    URLSearchParams, location: { search },
    document: {
      body: element('body'), getElementById: element, createElement: () => element(Symbol()), createTextNode: text => text,
    },
    fetch: async path => ({ ok: true, json: async () => path.endsWith('route.json') ? data : terrain }),
  });
  return { window, element, rendered, done };
}

test('production frames preload photos, freeze the view, and restore exact state on out-of-order seeks', async () => {
  const mark = route.landmarks[0];
  const stops = [{ src: 'photos/summit.jpg', landmark: mark.name, caption: 'caption', source: 'credit' }];
  let finishDecode;
  let beginDecode;
  const started = new Promise(resolve => { beginDecode = resolve; });
  const loaded = new Promise(resolve => { finishDecode = resolve; });
  const { window, element, rendered, done } = await videoFixture({
    viewport: [1080, 1920], stops, decode(src) { beginDecode(src); return loaded; },
  });
  assert.equal(await started, stops[0].src);
  assert.equal(window.videoReady, undefined);
  finishDecode();
  await done;
  assert.equal(window.videoReady, true, window.videoError);
  const km = route.points[mark.index][3];
  const timeline = createVideoTimeline({ distanceKm: route.stats.distanceKm, duration: 8, stops: [{ km }] });
  const photo = timeline.segments.find(segment => segment.phase === 'photo');
  const start = window.renderVideoFrame(photo.start);
  const marker = element('marker').style.transform;
  const camera = rendered.camera.position.toArray();
  const middle = window.renderVideoFrame(photo.start + 1);
  assert.equal(start.km, km);
  assert.equal(middle.km, km);
  assert.equal(middle.photoOpacity, 1);
  assert.equal(element('marker').style.transform, marker);
  assert.deepEqual(rendered.camera.position.toArray(), camera);
  assert.equal(element('photo-caption').textContent, 'caption');
  assert.equal(element('photo-source').textContent, 'credit');
  assert.equal(window.renderVideoFrame(photo.end).km, km);
  assert.equal(element('photo').hidden, true);
  assert.equal(window.renderVideoFrame(8).index, route.points.length - 1);
  const ribbon = rendered.scene.children.find(object => object.renderOrder === 2);
  assert.equal(ribbon.geometry.drawRange.count, (route.points.length - 1) * 6);
  assert.deepEqual(window.renderVideoFrame(photo.start + 1), middle);
  assert.equal(ribbon.geometry.drawRange.count, mark.index * 6);
  assert.equal(window.renderVideoFrame(0).index, 0);
  assert.equal(ribbon.geometry.drawRange.count, 0);
  assert.equal(element('photo').hidden, true);
  assert.doesNotMatch(element('source').textContent, /未提供/);
});

test('production scene reports failed image decoding and frames complete legacy routes at both aspect ratios', async () => {
  const { window, done } = await videoFixture({
    viewport: [640, 360], stops: [{ src: 'photos/broken.png', km: 1 }],
    decode: () => Promise.reject(Error('missing or broken')),
  });
  await done;
  assert.equal(window.videoReady, undefined);
  assert.match(window.videoError, /无法读取或解码照片：photos\/broken\.png/);

  const skip = await videoFixture({
    viewport: [640, 360], search: '?capture&duration=2&skipPhotos',
    stops: [{ src: 'photos/broken.png', km: 1 }],
    decode: () => assert.fail('map-only preview must not load a photo'),
  });
  await skip.done;
  assert.equal(skip.window.videoReady, true, skip.window.videoError);

  for (const viewport of [[1080, 1920], [1920, 1080]]) {
    const preview = await videoFixture({ viewport, search: '?capture&duration=2', legacy: true });
    await preview.done;
    const { window, rendered } = preview;
    assert.equal(window.videoReady, true, window.videoError);
    assert.equal(window.renderVideoFrame(1).phase, 'travel');
    const markerY = Number(preview.element('marker').style.transform.match(/,([\d.]+)px/)[1]);
    assert.ok(markerY / viewport[1] > .55 && markerY / viewport[1] < .78, `marker at ${markerY}px for ${viewport}`);
    assert.equal(window.renderVideoFrame(2).progress, 1);
    const line = rendered.scene.children.find(object => object.isLine);
    const positions = line.geometry.attributes.position;
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).project(rendered.camera);
      assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < .55, `outro point ${i} fell outside the map for ${viewport}`);
    }
  }
});
