import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three.module.js';
import * as style from '../route-style.js';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('function trackSample('), source.indexOf('\nfunction nearest('));
const functions = vm.runInNewContext(pure + '\n({trackSample,cityGeometry})', {THREE});
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
async function sceneFixture({buildingsFile='buildings.json',badFetch=false}={}) {
  const elements=new Map();
  function element(id){
    if(!elements.has(id))elements.set(id,{id,value:({exag:'3','building-exag':'1.5','flight-progress':'0','flight-speed':'1'})[id]||'',hidden:false,disabled:false,
      textContent:'',style:{setProperty(){}},children:[],attrs:new Map(),classList:{remove(){},toggle(){}},
      append(...items){this.children.push(...items);},setAttribute(k,v){this.attrs.set(k,v);},getAttribute(k){return this.attrs.get(k);},
      addEventListener(){},cloneNode(){return this;},replaceWith(){},getContext(){return new Proxy({},{get:()=>()=>{}});},getBoundingClientRect(){return {width:1200,height:900,left:0,top:0,bottom:0};}});
    return elements.get(id);
  }
  let tick,scene,camera,fetches=0;
  class Renderer {
    constructor(){this.domElement=element('map');this.capabilities={getMaxAnisotropy:()=>1};}
    setPixelRatio(){}setSize(){}setAnimationLoop(fn){tick=fn;}
    render(s,c){scene=s;camera=c;s.updateMatrixWorld();c.updateMatrixWorld();}
  }
  class Controls {
    constructor(c){this.camera=c;this.target=new THREE.Vector3();this.autoRotate=false;this.listeners={};}
    update(){this.camera.lookAt(this.target);}addEventListener(k,fn){this.listeners[k]=fn;}
  }
  const route=JSON.parse(await readFile(new URL('../data/route.json',import.meta.url),'utf8'));
  // Use the local demo track, moving a footprint onto its middle for independent-height checks.
  if(buildingsFile!==null)route.buildingsFile=buildingsFile;
  const p=functions.trackSample(route.points,route.points.at(-1)[3]/2),size=.0001;
  const buildings={version:1,source:{name:'test',url:'https://example.com',license:'test',extractedOn:'2026-10-24',corridorMeters:500},heightNote:'test estimates',
    buildings:[footprint({ring:[[p[0],p[1]],[p[0]+size,p[1]],[p[0]+size,p[1]+size],[p[0],p[1]+size]],heightM:339,minHeightM:200})]};
  const terrain=JSON.parse(await readFile(new URL('../data/terrain.json',import.meta.url),'utf8'));
  const context=vm.createContext({...style,THREE:{...THREE,WebGLRenderer:Renderer,TextureLoader:class{async loadAsync(){return new THREE.Texture();}}},OrbitControls:Controls,
    document:{getElementById:element,createElement:()=>element(Symbol()),createTextNode:text=>({textContent:text}),querySelector:element,querySelectorAll:()=>[]},matchMedia:()=>({matches:false}),
    innerWidth:1200,innerHeight:900,devicePixelRatio:1,performance:{now:()=>0},addEventListener(){},console:{...console,warn(){}},URL,encodeURIComponent,
    Image:class{constructor(){this.width=1200;this.height=1200;}async decode(){}},
    AbortSignal,location:{href:'http://localhost/'},fetch:async()=>{fetches++;if(badFetch)throw new Error('fixture failure');return {ok:true,json:async()=>buildings};}});
  const body=source.replace(/^import .*;\n/gm,'').slice(0,source.replace(/^import .*;\n/gm,'').lastIndexOf('\nmain().catch'));
  vm.runInContext(body,context);
  context.route=route;context.terrain=terrain;
  vm.runInContext('D=route;T=terrain;points=D.points;pointColors=points.map(()=>"#aabbcc");drawProfile=()=>{};',context);
  await vm.runInContext('init3D()',context);await new Promise(r=>setImmediate(r));tick(0);
  return {element,step:tick,get scene(){return scene;},get camera(){return camera;},get fetches(){return fetches;},point:()=>vm.runInContext('flightPoint',context),flat:()=>vm.runInContext('flatFallback()',context)};
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
