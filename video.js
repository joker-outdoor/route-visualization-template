import * as THREE from 'three';
import { landmarkPoint } from './route-style.js';
import { createCameraTrack, createVideoTimeline, resolveVideoStops, sampleVideoTimeline } from './video-story.js';

const $ = id => document.getElementById(id);
const clamp = (x, a=0, b=1) => Math.max(a, Math.min(b,x));
try {
  const read = async path => { const r=await fetch(path); if(!r.ok) throw Error(`${path}: HTTP ${r.status}`); return r.json(); };
  const [D,T]=await Promise.all([read('data/route.json'),read('data/terrain.json')]);
  const points=D.points, lakes=D.landmarks ?? D.lakes ?? [], total=D.stats.distanceKm;
  if (!points || points.length < 2 || !Number.isFinite(total) || total <= 0) throw Error('路线数据为空');
  const params = new URLSearchParams(location.search);
  const capture = params.has('capture');
  const defaultDuration = params.has('duration') ? Number(params.get('duration')) : 46;
  const stops = params.has('skipPhotos') ? [] : resolveVideoStops(D.video, lakes, points, total);
  const makeTimeline = duration => createVideoTimeline({ distanceKm: total, duration, stops });
  let timeline = makeTimeline(defaultDuration);
  const photos = await Promise.all(stops.map(async stop => {
    const img = new Image();
    img.alt = stop.name ?? '';
    img.src = stop.src;
    try { await img.decode(); }
    catch { throw Error(`无法读取或解码照片：${stop.src}`); }
    return img;
  }));

  $('title').textContent = D.title;
  $('subtitle').textContent = [
    `${total.toFixed(2)} km`,
    D.stats.gainM == null ? '' : `累计爬升 ${Math.round(D.stats.gainM)} m`,
    [D.startName, D.finishName].filter(Boolean).join(' → '),
  ].filter(Boolean).join(' · ');
  $('source').textContent = [
    D.imageryCredit ?? '卫星影像 © Esri, Maxar, Earthstar Geographics',
    D.terrainCredit ?? '高程 SRTM / AWS Terrain Tiles',
    D.recordedOn && `轨迹 ${D.recordedOn}`,
    D.madeOn && `制作 ${D.madeOn}`,
  ].filter(Boolean).join(' · ');
  $('notes').textContent = [
    lakes.length && (D.landmarkNote ?? '地标标注里程对应邻近轨迹点。'),
    '动画按距离推进，用时不代表实际速度。',
  ].filter(Boolean).join(' ');
  const renderer=new THREE.WebGLRenderer({canvas:$('map'),antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(innerWidth,innerHeight,false); renderer.setPixelRatio(1); renderer.outputColorSpace=THREE.SRGBColorSpace;
  const scene=new THREE.Scene(); scene.background=new THREE.Color('#091319');
  scene.add(new THREE.HemisphereLight('#f2f7ed','#243e48',1.6));
  const sun=new THREE.DirectionalLight('#fff1d6',1.4);sun.position.set(-5,12,8);scene.add(sun);
  const W=D.widthKm,H=D.heightKm,span=Math.max(W,H),base=Math.min(...T.elevations),exag=2.4;
  const camera=new THREE.PerspectiveCamera(42,innerWidth/innerHeight,span/10000,span*20);
  window.videoPointCount=points.length;
  const sample=(u,v)=>{
    const x=clamp(u)*(T.w-1),y=clamp(v)*(T.h-1),xi=Math.min(T.w-2,Math.floor(x)),yi=Math.min(T.h-2,Math.floor(y)),fx=x-xi,fy=y-yi,i=yi*T.w+xi;
    return T.elevations[i]*(1-fx)*(1-fy)+T.elevations[i+1]*fx*(1-fy)+T.elevations[i+T.w]* (1-fx)*fy+T.elevations[i+T.w+1]*fx*fy;
  };
  const xyz=p=>new THREE.Vector3((p[4]-.5)*W,(sample(p[4],p[5])-base+16)/1000*exag,(p[5]-.5)*H);
  const geometry=new THREE.PlaneGeometry(W,H,T.w-1,T.h-1);geometry.rotateX(-Math.PI/2);
  T.elevations.forEach((e,i)=>geometry.attributes.position.setY(i,(e-base)/1000*exag));geometry.computeVertexNormals();
  const texture=await new THREE.TextureLoader().loadAsync('data/satellite.jpg');texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  scene.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({map:texture,roughness:1})));
  const vertices=points.map(xyz), routeGeo=new THREE.BufferGeometry().setFromPoints(vertices);
  scene.add(new THREE.Line(routeGeo,new THREE.LineBasicMaterial({color:'#b9ef69',transparent:true,opacity:.35,depthTest:false})));
  const ribbonPositions = [];
  // Each segment has its own quad so an exact reversal cannot collapse the ribbon.
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1], b = vertices[i];
    const side = new THREE.Vector3(a.z - b.z, 0, b.x - a.x).normalize().multiplyScalar(span * .0018);
    const left = p => p.clone().sub(side).toArray();
    const right = p => p.clone().add(side).toArray();
    ribbonPositions.push(...left(a), ...right(a), ...left(b), ...right(a), ...right(b), ...left(b));
  }
  const ribbon = new THREE.BufferGeometry();
  ribbon.setAttribute('position', new THREE.Float32BufferAttribute(ribbonPositions, 3));
  const material = new THREE.MeshBasicMaterial({ color: '#b9ef69', depthTest: false, side: THREE.DoubleSide });
  const traveled = new THREE.Mesh(ribbon, material);
  const tip = new THREE.BufferGeometry();
  const tipPositions = new THREE.BufferAttribute(new Float32Array(18), 3);
  tip.setAttribute('position', tipPositions);
  const partial = new THREE.Mesh(tip, material);
  partial.frustumCulled = false;
  traveled.renderOrder = partial.renderOrder = 2;
  scene.add(traveled, partial);

  function drawTraveled({ index, fraction, pos }) {
    const complete = fraction === 1 ? index : Math.max(0, index - 1);
    ribbon.setDrawRange(0, complete * 6);
    partial.visible = fraction > 0 && fraction < 1;
    if (!partial.visible) return;
    const start = (index - 1) * 18;
    const end = vertices[index];
    tipPositions.array.set(ribbonPositions.slice(start, start + 18));
    for (const vertex of [2, 4, 5]) {
      const i = vertex * 3;
      tipPositions.setXYZ(vertex,
        tipPositions.array[i] + pos.x - end.x,
        tipPositions.array[i + 1] + pos.y - end.y,
        tipPositions.array[i + 2] + pos.z - end.z);
    }
    tipPositions.needsUpdate = true;
  }
  const labels=lakes.map((l,i)=>{
    const el=document.createElement('div');el.className='label';
    const b=document.createElement('b');b.textContent=String(i+1);el.append(b,document.createTextNode(l.name));
    const s=document.createElement('span');s.textContent=`${l.preservePosition ? '最近轨迹 ' : ''}${points[l.index][3].toFixed(1)} km`;el.append(s);$('labels').append(el);
    const p=xyz(landmarkPoint(D,l));p.y+=span*.03;return {el,p,index:l.index};
  });
  const profile=$('profile'),ctx=profile.getContext('2d');
  profile.width=profile.clientWidth;profile.height=profile.clientHeight;
  const pw=profile.width,ph=profile.height,lo=D.stats.minM-30,hi=D.stats.maxM+30;
  const X=km=>8+km/total*(pw-16),Y=e=>20+(hi-e)/(hi-lo)*(ph-45);
  function drawProfile(km,ele){
    ctx.clearRect(0,0,pw,ph);ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(X(p[3]),Y(p[2])):ctx.moveTo(X(p[3]),Y(p[2])));ctx.strokeStyle='#7f9e9d66';ctx.lineWidth=2;ctx.stroke();
    ctx.beginPath();ctx.moveTo(X(0),ph-25);for(const p of points){if(p[3]>km)break;ctx.lineTo(X(p[3]),Y(p[2]));}ctx.lineTo(X(km),Y(ele));ctx.lineTo(X(km),ph-25);ctx.closePath();
    const g=ctx.createLinearGradient(0,0,0,ph);g.addColorStop(0,'#b9ef69a0');g.addColorStop(1,'#b9ef6905');ctx.fillStyle=g;ctx.fill();
    ctx.fillStyle='#a8bfbe';ctx.textAlign='center';ctx.font='14px system-ui';lakes.forEach((l,i)=>{const p=points[l.index];ctx.fillText(String(i+1),X(p[3]),ph-5);});
    ctx.strokeStyle='#fff8';ctx.beginPath();ctx.moveTo(X(km),10);ctx.lineTo(X(km),ph-25);ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(X(km),Y(ele),5,0,Math.PI*2);ctx.fill();
  }
  function locate(km) {
    if (km >= total) {
      return { index: points.length - 1, pos: vertices.at(-1).clone(), ele: points.at(-1)[2], fraction: 1 };
    }
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid][3] < km) lo = mid + 1;
      else hi = mid;
    }
    const prev = Math.max(0, lo - 1);
    const length = points[lo][3] - points[prev][3];
    const fraction = length > 0 ? clamp((km - points[prev][3]) / length) : 0;
    return {
      index: lo, fraction,
      pos: vertices[prev].clone().lerp(vertices[lo], fraction),
      ele: THREE.MathUtils.lerp(points[prev][2], points[lo][2], fraction),
    };
  }

  const portrait = innerWidth < innerHeight;
  const routeBounds = new THREE.Box3().setFromPoints(vertices);
  const center = routeBounds.getCenter(new THREE.Vector3());
  const radius = routeBounds.getSize(new THREE.Vector3()).length() / 2;
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // Reserve the top and bottom of the overview for headings, credits and the profile.
  const overview = radius / Math.sin(Math.atan(vertical * Math.min(.40, camera.aspect * .82)));
  camera.far = Math.max(camera.far, overview + radius + span);
  camera.updateProjectionMatrix();
  const near = span * (portrait ? .34 : .24);
  const cameraAt = createCameraTrack(points, vertices, total);
  const overviewPosition = center.clone().add(new THREE.Vector3(-.16, .88, .45).normalize().multiplyScalar(overview));
  const nextLandmarks = [...lakes].sort((a,b) => points[a.index][3] - points[b.index][3]);
  const imageSlot = $('photo-image');

  window.renderVideoFrame = (seconds, duration = defaultDuration) => {
    if (timeline.duration !== duration) timeline = makeTimeline(duration);
    const { km, phase, travelView, photoIndex, photoOpacity } = sampleVideoTimeline(timeline, seconds);
    const p = locate(km);
    const { angle, pullback } = cameraAt(km);
    const direction = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const distance = near * (1 + .45 * pullback);
    const target = p.pos.clone().addScaledVector(direction, distance * .23);
    const position = p.pos.clone().addScaledVector(direction, -distance * .76);
    const ground = sample(position.x / W + .5, position.z / H + .5);
    position.y = Math.max(p.pos.y, (ground - base) / 1000 * exag) + distance * .79;
    camera.position.copy(overviewPosition).lerp(position, travelView);
    camera.lookAt(center.clone().lerp(target, travelView));
    camera.updateMatrixWorld();
    drawTraveled(p);
    renderer.render(scene, camera);
    const marker = p.pos.clone().project(camera);
    $('marker').style.transform = `translate(${(marker.x + 1) * innerWidth / 2}px,${(1 - marker.y) * innerHeight / 2}px) translate(-50%,-50%)`;
    const placed=[];
    labels.forEach(({el,p:pos,index})=>{
      const v=pos.clone().project(camera),x=(v.x+1)*innerWidth/2;let y=(1-v.y)*innerHeight/2;
      const w=el.offsetWidth,h=el.offsetHeight;
      if(v.z<-1||v.z>1||x<w/2+15||x>innerWidth-w/2-15||y<innerHeight*.23||y>innerHeight*.74){el.style.visibility='hidden';return;}
      for(let n=0;n<10;n++){const hit=placed.find(q=>Math.abs(q.x-x)<(q.w+w)/2+8&&Math.abs(q.y-y)<(q.h+h)/2+6);if(!hit)break;y=hit.y-(hit.h+h)/2-8;}
      if(y<innerHeight*.23){el.style.visibility='hidden';return;}
      placed.push({x,y,w,h});el.style.visibility='visible';el.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;el.style.opacity=index<=p.index?'1':'.75';
    });
    const overviewPhase = phase === 'overview' || phase === 'outro';
    document.body.classList.toggle('in-travel', !overviewPhase);
    $('phase').textContent = phase === 'outro' ? '全程抵达' : '路线全貌';
    $('distance').textContent = km.toFixed(2);
    const next = nextLandmarks.find(landmark => points[landmark.index][3] > km);
    $('next').textContent = next ? `下一站 ${next.name}` : D.finishName || '';
    if (overviewPhase) drawProfile(km, p.ele);

    const photo = stops[photoIndex];
    $('photo').style.opacity = photoOpacity ?? 0;
    $('photo').hidden = !photo;
    if (photo && imageSlot.firstChild !== photos[photoIndex]) {
      imageSlot.replaceChildren(photos[photoIndex]);
      $('photo-name').textContent = photo.name ?? '';
      $('photo-caption').textContent = photo.caption ?? '';
      $('photo-source').textContent = photo.source ?? '';
    }
    return { km, index: p.index, ele: p.ele, progress: km / total, phase, photoIndex, photoOpacity };
  };
  window.renderVideoFrame(0);
  window.videoReady = true;
  if (!capture) {
    const start = performance.now();
    function animate(now) {
      window.renderVideoFrame(((now - start) / 1000) % defaultDuration);
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }
} catch (error) {
  $('error').textContent = '视频场景加载失败：' + error.message;
  window.videoError = error.message;
}
