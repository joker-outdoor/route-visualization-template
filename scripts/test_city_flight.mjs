import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three.module.js';
import * as style from '../route-style.js';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('function trackSample('), source.indexOf('\nfunction nearest('));
const functions = vm.runInNewContext(pure + '\n({trackSample,cityGeometry,kilometerConfig,kilometerDefinitions})', {THREE});
const footprint = (overrides = {}) => ({id:'test',ring:[[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]],heightM:100,minHeightM:20,heightSource:'osm-height',part:true,...overrides});
const project = (x,z) => new THREE.Vector3(x,.5,z);

test('distance interpolation retains sharp corners, repeated distances and exact endpoints', () => {
  const points = [[0,0,10,0,0,0],[1,0,20,1,1,0],[1,0,20,1,1,0],[1,1,30,2,1,1]];
  assert.deepEqual(Array.from(functions.trackSample(points,.5)),[.5,0,15,.5,.5,0]);
  assert.deepEqual(Array.from(functions.trackSample(points,1.5)),[1,.5,25,1.5,1,.5]);
  assert.equal(functions.trackSample(points,-1)[3],0);
  assert.deepEqual(Array.from(functions.trackSample(points,9)),points.at(-1));
});

test('concave roof area, outward normals and suspended bottom stay correct in one mesh', () => {
  for (const ring of [footprint().ring, footprint().ring.toReversed()]) {
    const city = functions.cityGeometry([footprint({ring})],project), p=city.geometry.attributes.position;
    for (let i=0;i<p.count;i++) p.setY(i,city.grounds[i]+city.offsets[i]);
    city.geometry.computeVertexNormals();
    const normals=city.geometry.attributes.normal;let topArea=0,bottomArea=0;
    for(let i=0;i<p.count;i+=3){
      const a=new THREE.Vector3().fromBufferAttribute(p,i),b=new THREE.Vector3().fromBufferAttribute(p,i+1),c=new THREE.Vector3().fromBufferAttribute(p,i+2);
      const cross=b.sub(a).cross(c.sub(a));
      if(Math.abs(normals.getY(i))>.99){
        if(normals.getY(i)>0)topArea+=cross.length()/2;else bottomArea+=cross.length()/2;
      }
    }
    assert.equal(topArea,3);assert.equal(bottomArea,3);
    assert(Math.abs(Math.min(...Array.from({length:p.count},(_,i)=>p.getY(i)))-.52)<1e-6);
    assert(Math.abs(Math.max(...Array.from({length:p.count},(_,i)=>p.getY(i)))-.6)<1e-6);
    assert.equal(city.roofs.length,1);assert.equal(city.skipped,0);city.geometry.dispose();
  }
  const city=functions.cityGeometry([footprint(),footprint({id:'thin tower',heightM:339,minHeightM:300}),footprint({heightM:NaN}),footprint({ring:[[0,0],[1,1],[0,0]]})],project);
  assert.equal(city.roofs.length,2);assert.equal(city.skipped,2);city.geometry.dispose();
});

// Exercise the actual app handlers, geometry and camera with a CPU renderer/DOM stub.
// This verifies scene state, not WebGL output, browser layout or visual acceptance.
export async function sceneFixture({buildingsFile='buildings.json',badFetch=false,viewport=[1200,900],towerAhead=0,towerSide=0,flat=false,routeData,terrainData,cityData,detailManifest,imageryDetailFile,reduced=false}={}) {
  const elements=new Map();
  let [width,height]=viewport;
  const events=new Map();
  function rect(id){
    const mobile=width<760;
    const bounds=id==='header'?[12,20,width-12,mobile?90:110]:id==='side'?(mobile?[12,height-411,width-12,height-207]:[24,128,302,height-270]):
      id==='tools'?(mobile?[12,height-509,width-12,height-419]:[width-272,22,width-22,280]):id==='profile'?[12,height-(mobile?197:245),width-12,height-32]:[0,0,width,height];
    const [left,top,right,bottom]=bounds;return {left,top,right,bottom,width:right-left,height:bottom-top};
  }
  function element(id){
    if(!elements.has(id))elements.set(id,{id,value:({exag:'3','building-exag':'1.5','flight-progress':'0','flight-speed':'1'})[id]||'',hidden:false,disabled:false,
      offsetWidth:48,offsetHeight:22,textContent:'',style:{setProperty(){}},children:[],attrs:new Map(),classList:{remove(){},toggle(){}},
      remove(){this.removed=true;},append(...items){this.children.push(...items);},setAttribute(k,v){this.attrs.set(k,v);},getAttribute(k){return this.attrs.get(k);},
      addEventListener(){},cloneNode(){return this;},replaceWith(){},getContext(){return new Proxy({},{get:()=>()=>{}});},getBoundingClientRect(){return rect(id);}});
    return elements.get(id);
  }
  let tick,scene,camera,controls,fetches=0;
  class Renderer {
    constructor(){this.domElement=element('map');this.capabilities={getMaxAnisotropy:()=>1};}
    setPixelRatio(){}setSize(){}setAnimationLoop(fn){tick=fn;}
    render(s,c){scene=s;camera=c;s.updateMatrixWorld();c.updateMatrixWorld();}
  }
  class Controls {
    constructor(c){controls=this;this.camera=c;this.target=new THREE.Vector3();this.autoRotate=false;this.listeners={};}
    update(){this.camera.lookAt(this.target);}addEventListener(k,fn){this.listeners[k]=fn;}
  }
  const route=structuredClone(routeData||JSON.parse(await readFile(new URL('../data/route.json',import.meta.url),'utf8')));
  // Use the local demo track, moving a footprint onto its middle for independent-height checks.
  if(buildingsFile!==null)route.buildingsFile=buildingsFile;
  if(imageryDetailFile!==undefined)route.imageryDetailFile=imageryDetailFile;
  else if(detailManifest!==undefined)route.imageryDetailFile='imagery-detail.json';
  const mid=route.points.at(-1)[3]/2,p=functions.trackSample(route.points,mid),size=.0001;
  const a=functions.trackSample(route.points,mid-.05),b=functions.trackSample(route.points,mid+.05);
  const direction=new THREE.Vector2((b[4]-a[4])*route.widthKm,(b[5]-a[5])*route.heightKm).normalize();
  const [mx0,my0,mx1,my1]=route.bounds.mercator;
  const mx=mx0+(p[4]+(direction.x*towerAhead-direction.y*towerSide)/route.widthKm)*(mx1-mx0);
  const my=my0+(p[5]+(direction.y*towerAhead+direction.x*towerSide)/route.heightKm)*(my1-my0);
  const lon=mx*360-180,lat=Math.atan(Math.sinh(Math.PI*(1-2*my)))*180/Math.PI;
  const buildings=cityData||{version:1,source:{name:'test',url:'https://example.com',license:'test',extractedOn:'2026-10-24',corridorMeters:500},heightNote:'test estimates',
    buildings:[footprint({ring:[[lon,lat],[lon+size,lat],[lon+size,lat+size],[lon,lat+size]],heightM:339,minHeightM:200})]};
  const terrain=structuredClone(terrainData||JSON.parse(await readFile(new URL('../data/terrain.json',import.meta.url),'utf8')));
  if(flat)terrain.elevations.fill(500);
  const context=vm.createContext({...style,THREE:{...THREE,WebGLRenderer:Renderer,TextureLoader:class{async loadAsync(){return new THREE.Texture({width:1024,height:1024});}}},OrbitControls:Controls,
    document:{getElementById:element,createElement:()=>element(Symbol()),createTextNode:text=>({textContent:text}),querySelector:element,querySelectorAll:selector=>selector==='.kilometer'?Array.from(elements.values()).filter(e=>e.className==='map-label kilometer'&&!e.removed):[]},matchMedia:()=>({matches:reduced}),
    innerWidth:width,innerHeight:height,devicePixelRatio:1,performance:{now:()=>0},addEventListener(name,fn){events.set(name,fn);},console:{...console,warn(){}},URL,encodeURIComponent,
    Image:class{constructor(){this.width=1200;this.height=1200;}async decode(){}},
    AbortSignal,location:{href:'http://localhost/'},fetch:async url=>{fetches++;if(badFetch)throw new Error('fixture failure');return {ok:true,json:async()=>url==='data/imagery-detail.json'?detailManifest:buildings};}});
  const body=source.replace(/^import .*;\n/gm,'').slice(0,source.replace(/^import .*;\n/gm,'').lastIndexOf('\nmain().catch'));
  vm.runInContext(body,context);
  context.route=route;context.terrain=terrain;
  vm.runInContext('D=route;T=terrain;points=D.points;pointColors=points.map(()=>"#aabbcc");drawProfile=()=>{};',context);
  await vm.runInContext('init3D()',context);await new Promise(r=>setImmediate(r));tick(0);
  return {element,allElements:()=>Array.from(elements.values()).filter(e=>!e.removed),display:km=>vm.runInContext(`distanceText(${km})`,context),step:tick,rect,get scene(){return scene;},get camera(){return camera;},get controls(){return controls;},get fetches(){return fetches;},point:()=>vm.runInContext('flightPoint',context),flat:()=>vm.runInContext('flatFallback()',context),
    resize(w,h){width=w;height=h;context.innerWidth=w;context.innerHeight=h;events.get('resize')();}};
}

test('app handlers move the camera, freeze pause, seek, replay, toggle mesh and interrupt on overview',async()=>{
  const f=await sceneFixture(),e=f.element;
  assert.equal(e('buildings').getAttribute('aria-pressed'),'true');
  const mesh=f.scene.getObjectByName('city-buildings');assert(mesh);
  const terrain=f.scene.children.find(o=>o.isGroup).children[0].geometry.attributes.position.array.slice();
  const route=f.scene.children.find(o=>o.isGroup).children.find(o=>o.isLineSegments).geometry.attributes.position.array.slice();
  const before=mesh.geometry.attributes.position.array.slice();e('building-exag').value='2';e('building-exag').oninput();
  const after=mesh.geometry.attributes.position.array;assert.notDeepEqual(after,before);
  assert.deepEqual(f.scene.children.find(o=>o.isGroup).children[0].geometry.attributes.position.array,terrain);
  assert.deepEqual(f.scene.children.find(o=>o.isGroup).children.find(o=>o.isLineSegments).geometry.attributes.position.array,route);
  const lowBefore=Math.min(...Array.from({length:before.length/3},(_,i)=>before[i*3+1]));
  const lowAfter=Math.min(...Array.from({length:after.length/3},(_,i)=>after[i*3+1]));
  assert(Math.abs(lowAfter-lowBefore-.1)<1e-5); // suspended base: 200 m × 0.5 extra
  const previousRoof=Math.max(...Array.from({length:after.length/3},(_,i)=>after[i*3+1]));
  e('exag').value='1';e('exag').oninput();
  const currentRoof=Math.max(...Array.from({length:after.length/3},(_,i)=>after[i*3+1]));assert(currentRoof<previousRoof);
  e('buildings').onclick();assert.equal(mesh.visible,false);e('buildings').onclick();assert.equal(mesh.visible,true);
  e('flight-progress').value='500';e('flight-progress').oninput();f.step(100);
  const sought=f.camera.position.clone(),progress=e('flight-progress').value;
  assert(Math.hypot(sought.x,sought.z)<10);assert.equal(progress,'500');
  assert(f.camera.position.y>currentRoof); // high local tower is cleared
  e('flight-play').onclick();f.step(200);f.step(300);const normalKm=f.point()[3];
  f.step(400);const normalDelta=f.point()[3]-normalKm;e('flight-speed').value='4';f.step(500);
  assert(Math.abs((f.point()[3]-(normalKm+normalDelta))/normalDelta-4)<1e-5);
  assert(f.camera.position.distanceTo(sought)>0);
  e('flight-play').onclick();const paused=e('flight-progress').value,pose=f.camera.position.clone();f.step(600);f.step(900);
  assert.equal(e('flight-progress').value,paused);assert.deepEqual(f.camera.position,pose);
  e('flight-progress').value='250';e('flight-progress').oninput();assert(f.camera.position.distanceTo(pose)>.1);
  e('flight-play').onclick();e('overview').onclick();assert.equal(e('flight-play').getAttribute('aria-pressed'),'false');
  e('flight-progress').value='999';e('flight-progress').oninput();e('flight-play').onclick();f.step(1000);f.step(1100);
  assert.equal(e('flight-progress').value,'1000');assert.equal(e('flight-play').getAttribute('aria-pressed'),'false');
  e('flight-play').onclick();assert.equal(e('flight-progress').value,'0');assert.equal(e('flight-play').getAttribute('aria-pressed'),'true');
});

test('no building filename makes no request; load failure preserves terrain and flight',async()=>{
  const missing=await sceneFixture({buildingsFile:null});assert.equal(missing.fetches,0);assert.equal(missing.element('flight-play').disabled,false);
  const failed=await sceneFixture({badFetch:true});assert.equal(failed.element('flight-play').disabled,false);
  assert.match(failed.element('building-note').textContent,/不可用/);failed.element('flight-play').onclick();failed.step(1);failed.step(101);
  assert(failed.point()[3]>0);
});

test('2D fallback keeps the map path and disables flight controls',async()=>{
  const f=await sceneFixture({buildingsFile:null});await f.flat();
  assert.equal(f.element('tools').hidden,true);
  for(const id of ['flight-play','flight-progress','flight-speed'])assert.equal(f.element(id).disabled,true);
  assert.equal(f.fetches,0);
});

test('pause and manual controls release the camera; a seek and the endpoint do not keep applying clearance',async()=>{
  const f=await sceneFixture(),e=f.element;
  e('flight-progress').value='500';e('flight-progress').oninput();f.step(100);
  const interpolated=Array.from(f.point()),lens=f.camera.projectionMatrix.clone();
  f.camera.position.y=-.1;f.step(200);
  assert.equal(f.camera.position.y,-.1);assert.deepEqual(Array.from(f.point()),interpolated);
  e('flight-play').onclick();f.step(300);f.step(400);e('flight-play').onclick();
  const paused=e('flight-progress').value;f.camera.position.y=-.1;f.step(500);
  assert.equal(f.camera.position.y,-.1);assert.equal(e('flight-progress').value,paused);
  assert.deepEqual(f.camera.projectionMatrix,lens);assert.equal(f.controls.enableDamping,true);
  e('flight-play').onclick();f.controls.listeners.start();f.camera.position.y=-.1;f.step(600);
  assert.equal(f.camera.position.y,-.1);assert.equal(e('flight-play').getAttribute('aria-pressed'),'false');
  e('rotate').onclick();assert.equal(f.controls.autoRotate,true);f.camera.position.y=-.1;f.step(700);assert.equal(f.camera.position.y,-.1);
  e('overview').onclick();assert.equal(f.camera.fov,38);assert.equal(f.controls.autoRotate,false);
  e('flight-progress').value='999';e('flight-progress').oninput();e('flight-speed').value='4';e('flight-play').onclick();f.step(800);f.step(900);
  assert.equal(e('flight-play').getAttribute('aria-pressed'),'false');f.camera.position.y=-.1;f.step(1000);assert.equal(f.camera.position.y,-.1);
});

test('forward and close side towers fit with the route inside the uncovered desktop/mobile map',async()=>{
  for(const viewport of [[1280,900],[390,844]])for(const [towerAhead,towerSide] of [[1.1,0],[-.1,.2]]){
    const f=await sceneFixture({viewport,towerAhead,towerSide,flat:true}),e=f.element;
    for(const scale of ['1.5','2','4']){
      e('building-exag').value=scale;e('building-exag').oninput();e('flight-progress').value='500';e('flight-progress').oninput();f.step(100);
      const box=new THREE.Box3().setFromBufferAttribute(f.scene.getObjectByName('city-buildings').geometry.attributes.position);
      const [w,h]=viewport,side=f.rect('side'),tools=f.rect('tools'),profile=f.rect('profile');
      const left=w<760?12:side.right+16,right=w<760?w-12:tools.left-12,top=f.rect('header').bottom+12,bottom=Math.min(profile.top,w<760?Math.min(side.top,tools.top):h)-12;
      const inside=point=>{
        const p=point.clone().project(f.camera),x=(p.x+1)*w/2,y=(1-p.y)*h/2;
        assert(p.z>-1&&p.z<1);assert(x>left&&x<right,`tower/route x=${x} outside ${left}..${right}`);
        assert(y>top&&y<bottom,`tower/route y=${y} outside ${top}..${bottom}`);
      };
      for(const x of [box.min.x,box.max.x])for(const z of [box.min.z,box.max.z])for(const y of [box.min.y,box.max.y])inside(new THREE.Vector3(x,y,z));
      const point=f.point(),terrain=f.scene.children.find(o=>o.isGroup).children[0];
      inside(new THREE.Vector3((point[4]-.5)*terrain.geometry.parameters.width,.306, (point[5]-.5)*terrain.geometry.parameters.height));
      assert(f.camera.position.distanceTo(new THREE.Vector3((point[4]-.5)*terrain.geometry.parameters.width,.3,(point[5]-.5)*terrain.geometry.parameters.height))<3);
      const marker=f.scene.getObjectByName('route-marker'),center=new THREE.Vector3();marker.getWorldPosition(center);
      const radius=marker.geometry.parameters.radius*marker.scale.x;
      const up=new THREE.Vector3(0,radius,0).applyQuaternion(f.camera.quaternion);
      const high=center.clone().add(up).project(f.camera),low=center.clone().sub(up).project(f.camera);
      assert(Math.abs((high.y-low.y)*h/2-8)<.1); // circular screen size, independent of terrain exaggeration
    }
    e('overview').onclick();assert.equal(f.camera.fov,38);e('top').onclick();assert.equal(f.camera.fov,38);
  }
});

function cornerRoute(base, xy) {
  const d=structuredClone(base);delete d.buildingsFile;delete d.imageryDetailFile;
  d.widthKm=4;d.heightKm=4;d.landmarks=[];let km=0;
  d.points=xy.map(([u,v],i)=>{
    if(i)km+=Math.hypot(u-xy[i-1][0],v-xy[i-1][1])*4;
    const [x0,y0,x1,y1]=d.bounds.mercator,x=x0+u*(x1-x0),y=y0+v*(y1-y0);
    return [x*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI,500,km,u,v];
  });d.stats.distanceKm=km;return d;
}

test('actual rendered pose stays below 25 deg/s through independent right angles, hairpins and zero directions at every speed',async()=>{
  const base=JSON.parse(await readFile(new URL('../data/route.json',import.meta.url),'utf8'));
  for(const xy of [[[.2,.4],[.7,.4],[.7,.8]],[[.2,.4],[.7,.4],[.7,.4],[.2,.4]]]){
    for(const speed of ['1','2','4']){
      const route=cornerRoute(base,xy),f=await sceneFixture({buildingsFile:null,routeData:route,flat:true,reduced:speed==='4'}),e=f.element;
      e('flight-progress').value='300';e('flight-progress').oninput();e('flight-speed').value=speed;e('flight-play').onclick();
      let previous=f.camera.quaternion.clone(),previousKm=0,maxRate=0;
      for(let i=1;i<=5400;i++){
        f.step(i*1000/60);const q=f.camera.quaternion;
        maxRate=Math.max(maxRate,previous.angleTo(q)*60*180/Math.PI);previous.copy(q);
        assert(f.point()[3]>=previousKm);previousKm=f.point()[3];assert(f.camera.position.toArray().every(Number.isFinite));
        if(i===300){
          e('flight-play').onclick();const paused=f.camera.quaternion.clone();f.step(i*1000/60+2);
          assert(paused.angleTo(f.camera.quaternion)<1e-7);e('flight-play').onclick();
          assert(paused.angleTo(f.camera.quaternion)<1e-7,'resume must not snap');
        }
      }
      assert(maxRate<25.01,`${speed}x: ${maxRate} deg/s`);assert(previousKm>2.4,`must pass the corner: ${previousKm}`);
      f.controls.listeners.start();f.step(90200);assert.equal(e('flight-play').getAttribute('aria-pressed'),'false');
    }
  }
});

test('resuming after manual takeover starts at the actual displayed position and direction',async()=>{
  const f=await sceneFixture({buildingsFile:null}),e=f.element;
  e('flight-progress').value='400';e('flight-progress').oninput();e('flight-play').onclick();f.step(100);f.step(200);
  f.controls.listeners.start();f.camera.position.add(new THREE.Vector3(.2,.2,-.1));f.controls.update();
  const position=f.camera.position.clone(),quaternion=f.camera.quaternion.clone();
  e('flight-play').onclick();assert(f.camera.position.distanceTo(position)<1e-9);assert(quaternion.angleTo(f.camera.quaternion)<1e-7);
  f.step(300);assert(f.camera.position.distanceTo(position)<1e-9);assert(quaternion.angleTo(f.camera.quaternion)<1e-7);
  f.step(400);assert(quaternion.angleTo(f.camera.quaternion)*180/Math.PI<=2.5);
});

test('kilometer roots, geometry mapping, endpoint readouts, overlap priority and 2D keep the same distance contract',async()=>{
  const base=JSON.parse(await readFile(new URL('../data/route.json',import.meta.url),'utf8'));
  const route=cornerRoute(base,[[.2,.4],[.7,.4],[.2,.4]]);
  route.kilometerMarkers={distanceKm:42.195,positionSource:'按官方全程42.195 km比例定位'};
  const f=await sceneFixture({buildingsFile:null,routeData:route,flat:true}),e=f.element;
  const roots=()=>f.allElements().filter(el=>el.getAttribute('data-km')!=null);
  assert.equal(roots().length,42);
  for(const el of roots()){
    const k=Number(el.getAttribute('data-km')),g=Number(el.getAttribute('data-geometry-km'));
    assert(Math.abs(g-k*route.points.at(-1)[3]/42.195)<1e-10);
    assert.equal(el.textContent,`${k} km`);assert.match(el.getAttribute('aria-label'),/公里/);
  }
  assert.equal(f.display(0),'0.00');assert.equal(f.display(route.points.at(-1)[3]),'42.195');
  e('flight-progress').value='1000';e('flight-progress').oninput();assert.equal(e('flight-distance').textContent,'42.195 / 42.195 km');
  e('flight-progress').value='720';e('flight-progress').oninput();f.step(100);
  // In the overlapping return half, the outbound marker at the same location is not a candidate.
  assert(roots().some(el=>!el.hidden),'return-leg signs must stay visible');
  assert(roots().filter(el=>!el.hidden).every(el=>Number(el.getAttribute('data-km'))>=30));
  await f.flat();assert.equal(roots().length,42);assert.equal(e('flight-play').disabled,true);
  const old=await sceneFixture({buildingsFile:null});assert.equal(old.allElements().filter(el=>el.getAttribute('data-km')!=null).length,0);
  assert.equal(old.display(1.25),'1.25');
  for(const bad of [null,{},true,{distanceKm:true,positionSource:'x'},{distanceKm:'42.195',positionSource:'x'},
    {distanceKm:NaN,positionSource:'x'},{distanceKm:Infinity,positionSource:'x'},{distanceKm:0,positionSource:'x'},
    {distanceKm:1001,positionSource:'x'},{distanceKm:42.195,positionSource:' '}]){
    const data={...route,kilometerMarkers:bad};assert.equal(functions.kilometerConfig(data),null);assert.equal(functions.kilometerDefinitions(data).length,0);
  }
  const invalid=await sceneFixture({buildingsFile:null,routeData:{...route,kilometerMarkers:{distanceKm:true,positionSource:'x'}},flat:true});
  assert.equal(invalid.allElements().filter(el=>el.getAttribute('data-km')!=null).length,0);assert.equal(invalid.display(1.25),'1.25');
  assert.equal(invalid.element('flight-play').disabled,false);
});
