const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

export function resolveVideoStops(video, landmarks, points, distanceKm) {
  if (video === undefined) return [];
  if (!video || !Array.isArray(video.stops)) throw Error('video.stops 必须是数组');
  return video.stops.map((stop, index) => {
    const label = `video.stops[${index}]`;
    if (!stop || typeof stop !== 'object') throw Error(`${label} 必须是对象`);
    for (const key of ['name', 'caption', 'source']) {
      if (key in stop && (typeof stop[key] !== 'string' || !stop[key].trim())) {
        throw Error(`${label}.${key} 必须是非空文本`);
      }
    }
    if (typeof stop.src !== 'string' || /[:?#%\\\x00-\x1f]/.test(stop.src) ||
        stop.src.split('/').some(part => !part.trim() || part === '.' || part === '..') ||
        !/\.(jpe?g|png|webp|avif)$/i.test(stop.src)) {
      throw Error(`${label}.src 必须是项目内的相对图片路径（JPEG、PNG、WebP、AVIF）`);
    }
    if (('km' in stop) === ('landmark' in stop)) throw Error(`${label} 必须指定 km 或 landmark 其中一项`);
    if ('km' in stop) return stop;
    const matches = landmarks.filter(mark => mark.name === stop.landmark);
    if (matches.length !== 1 || !points[matches[0].index]) {
      throw Error(`${label}.landmark 必须唯一匹配一个已定位地标：${stop.landmark}`);
    }
    const mark = matches[0];
    const km = mark.index === points.length - 1 ? distanceKm : Math.min(distanceKm, points[mark.index][3]);
    return { ...stop, km, name: stop.name ?? mark.name };
  });
}

export function createVideoTimeline({ distanceKm, duration, stops = [] }) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || !Number.isFinite(duration) || duration <= 0) {
    throw Error('路线距离和视频时长必须是正数');
  }
  const photos = stops.map((stop, index) => {
    const { km, holdSeconds = 3, transitionSeconds = .5 } = stop;
    if (!Number.isFinite(km) || km < 0 || km > distanceKm) {
      throw Error(`video.stops[${index}].km 必须在 0 到 ${distanceKm} 之间`);
    }
    if (!Number.isFinite(holdSeconds) || holdSeconds <= 0 ||
        !Number.isFinite(transitionSeconds) || transitionSeconds < 0) {
      throw Error(`video.stops[${index}] 的 holdSeconds 必须为正数、transitionSeconds 必须为非负数`);
    }
    return { km, holdSeconds, transitionSeconds, index, seconds: holdSeconds + 2 * transitionSeconds };
  }).sort((a, b) => a.km - b.km);
  const photoSeconds = photos.reduce((seconds, photo) => seconds + photo.seconds, 0);
  const minimum = photoSeconds + 2;
  if (photos.length && duration < minimum) {
    throw Error(`照片停留与地图镜头至少需要 ${Math.ceil(minimum * 1000) / 1000} 秒。请增加 --duration 或用 --skip-photos 预览地图。`);
  }
  const mapSeconds = duration - photoSeconds;
  const overviewSeconds = Math.min(3, mapSeconds * .13);
  const outroSeconds = Math.min(3, mapSeconds * .15);
  const travelSeconds = mapSeconds - overviewSeconds - outroSeconds;
  const segments = [];
  let start = 0;
  function add(phase, seconds, from, to, photo) {
    const end = start + seconds;
    segments.push({ phase, start, end, from, to, photo });
    start = end;
  }
  add('overview', overviewSeconds, 0, 0);
  let km = 0;
  for (const photo of photos) {
    if (photo.km > km) add('travel', (photo.km - km) / distanceKm * travelSeconds, km, photo.km);
    add('photo', photo.seconds, photo.km, photo.km, photo);
    km = photo.km;
  }
  if (km < distanceKm) add('travel', (distanceKm - km) / distanceKm * travelSeconds, km, distanceKm);
  add('outro', duration - start, distanceKm, distanceKm);
  return { duration, segments };
}

export function sampleVideoTimeline({ duration, segments }, seconds) {
  const time = clamp(seconds, 0, duration);
  const segment = segments.find(part => time < part.end) ?? segments.at(-1);
  const { phase, start, end, from, to, photo } = segment;
  const progress = time === duration ? 1 : clamp((time - start) / (end - start), 0, 1);
  const travelView = phase === 'overview' ? smooth((progress - .25) / .75) :
    phase === 'outro' ? 1 - smooth(progress / .65) : 1;
  const sample = { km: mix(from, to, progress), phase, travelView };
  if (photo) {
    const fade = photo.transitionSeconds;
    sample.photoIndex = photo.index;
    sample.photoOpacity = fade ? smooth(Math.min(time - start, end - time) / fade) : 1;
  }
  return sample;
}

// Smooth unwrapped segment headings over distance so the camera turns through a hairpin
// instead of averaging opposing vectors into an undefined direction.
export function createCameraTrack(points, vertices, distanceKm) {
  const directions = [];
  let angle = 0;
  for (let i = 1; i < points.length; i++) {
    const km = Math.min(distanceKm, points[i][3]);
    const dx = vertices[i].x - vertices[i - 1].x;
    const dz = vertices[i].z - vertices[i - 1].z;
    if (km <= points[i - 1][3] || Math.hypot(dx, dz) < 1e-10) continue;
    const heading = Math.atan2(dx, dz);
    let turn = Math.atan2(Math.sin(heading - angle), Math.cos(heading - angle));
    if (Math.abs(turn + Math.PI) < 1e-9) turn = Math.PI;
    angle = directions.length ? angle + turn : heading;
    directions.push({ km, angle });
  }
  if (!directions.length) return () => ({ angle: 0, pullback: 0 });

  const steps = 160;
  let segment = 0;
  const headings = Array.from({ length: steps + 1 }, (_, i) => {
    const km = i / steps * distanceKm;
    while (segment < directions.length - 1 && km >= directions[segment].km) segment++;
    return directions[segment].angle;
  });
  const radius = 8;
  const headingAt = i => headings[clamp(i, 0, steps)];
  const samples = headings.map((_, i) => {
    let average = 0, lowest = Infinity, highest = -Infinity;
    for (let offset = -radius; offset <= radius; offset++) {
      const heading = headingAt(i + offset);
      average += heading * (radius + 1 - Math.abs(offset));
      lowest = Math.min(lowest, heading);
      highest = Math.max(highest, heading);
    }
    return { angle: average / (radius + 1) ** 2, pullback: clamp((highest - lowest) / Math.PI, 0, 1) };
  });
  return km => {
    const position = clamp(km / distanceKm, 0, 1) * steps;
    const index = Math.floor(position);
    const a = samples[index], b = samples[Math.min(index + 1, steps)];
    return { angle: mix(a.angle, b.angle, position - index), pullback: mix(a.pullback, b.pullback, position - index) };
  };
}
