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
export async function sceneFixture({buildingsFile='buildings.json',badFetch=false,viewport=[1200,900],towerAhead=0,towerSide=0,flat=false,routeData,terrainData,cityData,detailManifest,imageryDetailFile,reduced=false,start='3d',imageFailure=false,beforeInit,rects={}}={}) {
  const elements=new Map();
  const canvasCalls=[],hiddenRectReads=[];
  let [width,height]=viewport;
  const events=new Map();
  function rect(id){
    const mobile=width<=760;
    if(elements.get('app')?.classList.contains('maximized')){
      if(['header','side','profile','point-card'].includes(id)){hiddenRectReads.push(id);return {left:0,top:0,right:0,bottom:0,width:0,height:0};}
      if(id==='tools')return {left:12,top:height-(width<=600?142:88),right:width-12,bottom:height-32,width:width-24,height:width<=600?110:56};
    }
    if(elements.get(id)?.hidden)return {left:0,top:0,right:0,bottom:0,width:0,height:0};
    if(id==='footer')return {left:12,top:height-20,right:width-12,bottom:height-8,width:width-24,height:12};
    // Only ordinary 2D uses the compact CSS layout; retain the 3D/maximized model.
    const flat=elements.get('app')?.classList.contains('flat-view'),short=height<=650;
    const flatBounds=flat?(mobile?{
      header:[12,12,width-12,78],side:[12,height-228,width-12,height-116],
      tools:[12,height-286,width-12,height-236],profile:[12,height-108,width-12,height-24],
      'point-card':[12,height-228,width-12,height-116],
      // Match the short landscape bottom strip in .flat-view:not(.maximized).
      ...(short&&width>height?{
        side:[12,height-104,12+width*.32,height-24],profile:[width*.32+20,height-104,width-132,height-24],
        tools:[width-124,height-74,width-12,height-24],'point-card':[12,height-104,12+width*.32,height-24]
      }:{})
    }:{
      ...(short?{header:[12,12,width-136,80],side:[12,96,192,height-132],profile:[12,height-120,width-12,height-24]}:{}),
      tools:[width-(short?124:134),short?12:22,width-(short?12:22),short?70:80],
      'point-card':[width-(short?192:204),height-(short?257:390),width-(short?12:24),height-(short?132:260)]
    }):{};
    const bounds=rects[id]??flatBounds[id]??(id==='header'?[12,20,width-12,mobile?90:110]:id==='side'?(mobile?[12,height-411,width-12,height-207]:[24,128,302,height-270]):
      id==='tools'?(mobile?[12,height-509,width-12,height-419]:[width-272,22,width-22,280]):id==='profile'?[12,height-(mobile?197:245),width-12,height-32]:
      id==='point-card'?(mobile?[width-222,height-520,width-12,height-420]:[width-344,height-340,width-24,height-260]):[0,0,width,height]);
    const [left,top,right,bottom]=bounds;return {left,top,right,bottom,width:right-left,height:bottom-top};
  }
  function element(id){
    const classes=new Set();
    if(!elements.has(id))elements.set(id,{id,value:({exag:'3','building-exag':'1.5','flight-progress':'0','flight-speed':'1'})[id]||'',hidden:id==='point-card',disabled:false,
      offsetWidth:48,offsetHeight:22,textContent:id==='maximize-view'?'最大化3D':'',style:{setProperty(){}},children:[],attrs:new Map(id==='maximize-view'?[['aria-pressed','false']]:[]),classList:{remove(c){classes.delete(c);},contains(c){return classes.has(c);},toggle(c,force){const on=force??!classes.has(c);if(on)classes.add(c);else classes.delete(c);return on;}},
      remove(){this.removed=true;},append(...items){this.children.push(...items);},setAttribute(k,v){this.attrs.set(k,v);},getAttribute(k){return this.attrs.get(k);},
      addEventListener(){},cloneNode(){return this;},replaceWith(){},getContext(){return new Proxy({},{get:(_,method)=>(...args)=>{canvasCalls.push({method,args});}});},getBoundingClientRect(){return rect(id);}});
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
    innerWidth:width,innerHeight:height,devicePixelRatio:1,performance:{now:()=>0},addEventListener(name,fn){events.set(name,fn);},console:{...console,warn(){},error(){}},URL,encodeURIComponent,
    Image:class{constructor(){this.width=1200;this.height=1200;}async decode(){if(imageFailure)throw new Error('fixture image failure');}},
    AbortSignal,location:{href:'http://localhost/'},fetch:async url=>{fetches++;if(badFetch)throw new Error('fixture failure');return {ok:true,json:async()=>url==='data/imagery-detail.json'?detailManifest:buildings};}});
  const body=source.replace(/^import .*;\n/gm,'').slice(0,source.replace(/^import .*;\n/gm,'').lastIndexOf('\nmain().catch'));
  vm.runInContext(body,context);
  beforeInit?.(element);
  context.route=route;context.terrain=terrain;
  vm.runInContext('D=route;T=terrain;points=D.points;pointColors=points.map(()=>"#aabbcc");drawProfile=()=>{};',context);
  if(start==='failure')await vm.runInContext(source.slice(source.lastIndexOf('\nmain().catch')),context);
  else if(start==='2d')await vm.runInContext('flatFallback()',context);
  else {await vm.runInContext('init3D()',context);await new Promise(r=>setImmediate(r));tick(0);}
  return {element,canvasCalls,hiddenRectReads,allElements:()=>Array.from(elements.values()).filter(e=>!e.removed),display:km=>vm.runInContext(`distanceText(${km})`,context),step:tick,rect,get scene(){return scene;},get camera(){return camera;},get controls(){return controls;},get fetches(){return fetches;},point:()=>vm.runInContext('flightPoint',context),flat:()=>vm.runInContext('flatFallback()',context),
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

test('actual route tubes cap long-course radius, retain short-course width and keep city width fixed',async()=>{
  const base=JSON.parse(await readFile(new URL('../data/route.json',import.meta.url),'utf8'));
  for(const [widthKm,heightKm,radius] of [[1,2,.0024],[35.38262469325277,32.609090996068886,.003]]){
    for(const buildingsFile of [null,'buildings.json']){
      const f=await sceneFixture({buildingsFile,routeData:{...base,widthKm,heightKm}});
      const world=f.scene.children.find(o=>o.isGroup);
      const tube=world.children.find(o=>o.geometry?.type==='TubeGeometry');
      assert(tube,'actual app route tube');
      assert.equal(tube.geometry.parameters.radius,buildingsFile ? .003 : radius);
      assert.equal(tube.geometry.attributes.color.count,tube.geometry.attributes.position.count);
    }
  }
});

test('no building filename makes no request; load failure preserves terrain and flight',async()=>{
  const missing=await sceneFixture({buildingsFile:null});assert.equal(missing.fetches,0);assert.equal(missing.element('flight-play').disabled,false);
  const failed=await sceneFixture({badFetch:true});assert.equal(failed.element('flight-play').disabled,false);
  assert.match(failed.element('building-note').textContent,/不可用/);failed.element('flight-play').onclick();failed.step(1);failed.step(101);
  assert(failed.point()[3]>0);
});

test('2D fallback keeps the map path and disables flight controls',async()=>{
  const f=await sceneFixture({buildingsFile:null});await f.flat();
  assert.equal(f.element('tools').hidden,false); // Keep the restore button reachable in 2D.
  assert.equal(f.element('app').classList.contains('flat-view'),true);
  for(const id of ['flight-play','flight-progress','flight-speed'])assert.equal(f.element(id).disabled,true);
  assert.equal(f.fetches,0);
});

test('maximize onclick restores the projection and reuses paused flight nodes and state',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.equal((html.match(/id="maximize-view"/g)||[]).length,1);
  for(const viewport of [[1200,900],[390,844],[844,390]]){
    const f=await sceneFixture({viewport}),e=f.element,button=e('maximize-view');
    const ids=['flight-play','flight-progress','flight-speed','flight-distance'],nodes=ids.map(e);
    assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(button.textContent,'最大化3D');
    const overview=f.camera.projectionMatrix.clone();button.onclick();
    assert.equal(button.textContent,'恢复面板');assert.equal(button.getAttribute('aria-pressed'),'true');
    assert.equal(e('app').classList.contains('maximized'),true);
    assert.equal(f.camera.view.offsetX,0);assert.equal(f.camera.view.offsetY,0);
    button.onclick();assert.deepEqual(f.camera.projectionMatrix,overview);
    e('flight-progress').value='500';e('flight-progress').oninput();e('flight-speed').value='4';f.step(100);
    const lens=f.camera.projectionMatrix.clone(),pose=f.camera.position.clone(),rotation=f.camera.quaternion.clone(),point=Array.from(f.point());
    button.onclick();f.step(200);f.step(500);
    assert.deepEqual(Array.from(f.point()),point);assert.deepEqual(f.camera.position,pose);assert(rotation.angleTo(f.camera.quaternion)<1e-7);
    assert.equal(e('flight-speed').value,'4');assert.equal(e('flight-play').getAttribute('aria-pressed'),'false');
    assert.notDeepEqual(f.camera.projectionMatrix,lens);assert.deepEqual(f.hiddenRectReads,[]);
    button.onclick();assert.deepEqual(f.camera.projectionMatrix,lens);assert.deepEqual(ids.map(e),nodes);
  }
});

test('maximized flight continues at the selected speed and reframes on resize without hidden panels',async()=>{
  const f=await sceneFixture({viewport:[390,844],buildingsFile:null}),e=f.element;
  e('flight-progress').value='300';e('flight-progress').oninput();e('flight-speed').value='2';e('flight-play').onclick();
  f.step(100);f.step(200);const point=Array.from(f.point()),pose=f.camera.position.clone();
  e('maximize-view').onclick();assert.deepEqual(Array.from(f.point()),point);assert.deepEqual(f.camera.position,pose);
  f.step(300);assert(f.point()[3]>point[3]);assert.equal(e('flight-play').getAttribute('aria-pressed'),'true');
  const oldLens=f.camera.projectionMatrix.clone();f.resize(844,390);assert.notDeepEqual(f.camera.projectionMatrix,oldLens);
  f.step(400);const km=f.point()[3];e('maximize-view').onclick();f.step(500);
  assert(f.point()[3]>km);assert.equal(e('flight-speed').value,'2');assert.deepEqual(f.hiddenRectReads,[]);
});

test('maximized framing fits towers and route above the visible bottom controls',async()=>{
  for(const viewport of [[1280,900],[390,844],[844,390]]){
    const f=await sceneFixture({viewport,towerAhead:1.1,flat:true}),e=f.element;
    e('maximize-view').onclick();e('building-exag').value='4';e('building-exag').oninput();
    e('flight-progress').value='500';e('flight-progress').oninput();f.step(100);
    const box=new THREE.Box3().setFromBufferAttribute(f.scene.getObjectByName('city-buildings').geometry.attributes.position);
    const [w,h]=viewport,bottom=Math.min(f.rect('tools').top,f.rect('footer').top)-12;
    const inside=point=>{const p=point.clone().project(f.camera),x=(p.x+1)*w/2,y=(1-p.y)*h/2;assert(p.z>-1&&p.z<1);assert(x>12&&x<w-12);assert(y>12&&y<bottom,`y=${y} vs ${bottom}`);};
    for(const x of [box.min.x,box.max.x])for(const z of [box.min.z,box.max.z])for(const y of [box.min.y,box.max.y])inside(new THREE.Vector3(x,y,z));
    const marker=f.scene.getObjectByName('route-marker');inside(marker.getWorldPosition(new THREE.Vector3()));
    assert.deepEqual(f.hiddenRectReads,[]);
    assert(f.allElements().filter(el=>el.className?.startsWith('map-label')).every(el=>el.hidden));
  }
});

test('2D maximize redraws without panel offsets or painted text and restores without enabling flight',async()=>{
  for(const viewport of [[1200,900],[390,844],[844,390]]){
    const f=await sceneFixture({start:'2d',viewport,buildingsFile:null}),e=f.element;
    const image=()=>f.canvasCalls.filter(call=>call.method==='drawImage').at(-1).args.slice(1);
    const original=image();assert(f.canvasCalls.some(call=>call.method==='fillText'));
    f.canvasCalls.length=0;e('maximize-view').onclick();
    const [x,y,w,h]=image();assert.equal(x+w/2,viewport[0]/2);assert(y>=12);assert(y+h<=f.rect('tools').top-12);
    assert(!f.canvasCalls.some(call=>call.method==='fillText'));assert.deepEqual(f.hiddenRectReads,[]);
    for(const id of ['flight-play','flight-progress','flight-speed'])assert.equal(e(id).disabled,true);
    e('maximize-view').onclick();assert.deepEqual(image(),original);assert(f.canvasCalls.some(call=>call.method==='fillText'));
    e('maximize-view').onclick();f.resize(viewport[1],viewport[0]);assert.notDeepEqual(image(),original);
    assert.equal(e('tools').hidden,false);
  }
});

test('normal 2D image avoids measured controls and panels on mobile and desktop after redraw and restore',async()=>{
  for(const viewport of [[667,375],[736,414],[375,667],[320,568],[844,390],[390,844],[1440,900],[759,900],[760,900],[761,900]]){
    const rects={},f=await sceneFixture({start:'2d',viewport,buildingsFile:null,rects}),e=f.element;
    const image=()=>{const draw=f.canvasCalls.findLast(call=>call.method==='drawImage');assert(draw,'expected a fresh 2D draw');return draw.args;};
    const check=(minSize=160,size=viewport)=>{
      const [img,x,y,w,h]=image();
      assert([x,y,w,h].every(Number.isFinite));assert(Math.min(w,h)>=minSize,`2D image too small at ${size}: ${w}×${h}`);
      assert(Math.abs(w/h-img.width/img.height)<1e-10);
      assert(x>=0&&y>=0&&x+w<=size[0]&&y+h<=size[1]);
      for(const id of ['header','tools','side','profile','point-card']){
        if(e(id).hidden)continue;
        const r=f.rect(id);if(!r.width||!r.height)continue;
        assert(x+w<=r.left||x>=r.right||y+h<=r.top||y>=r.bottom,`2D image intersects ${id} at ${size}`);
      }
      assert.equal(e('tools').hidden,false);assert.equal(typeof e('maximize-view').onclick,'function');
      for(const id of ['flight-play','flight-progress','flight-speed'])assert.equal(e(id).disabled,true);
    };
    check();const original=image().slice(1);
    const t=f.rect('tools');
    rects.tools=viewport[0]<=760?[t.left,original[1]+original[3]/2,t.right,t.bottom]:[original[0]+original[2]/2,t.top,t.right,t.bottom];
    f.canvasCalls.length=0;f.resize(...viewport);check(1);assert.notDeepEqual(image().slice(1),original);
    delete rects.tools;f.canvasCalls.length=0;f.resize(...viewport);check();
    // Selecting an endpoint opens the actual detail card and redraws the map.
    f.canvasCalls.length=0;
    f.allElements().find(el=>el.className==='endpoint-marker endpoint-start').onclick();check();
    assert.equal(e('point-card').hidden,false);
    if(viewport[0]>760)assert.notDeepEqual(image().slice(1),original);
    const withCard=image().slice(1);e('maximize-view').onclick();f.canvasCalls.length=0;e('maximize-view').onclick();check();
    assert.deepEqual(image().slice(1),withCard);
    f.canvasCalls.length=0;e('close-card').onclick();check();
    assert.deepEqual(image().slice(1),original,'closing the card must immediately restore the original framing');
    rects.tools=[0,0,0,0];f.canvasCalls.length=0;f.resize(...viewport);check();
    delete rects.tools;
    // Resize through both CSS layouts and restore the exact original framing.
    f.canvasCalls.length=0;f.resize(844,390);check(160,[844,390]);
    f.canvasCalls.length=0;f.resize(320,568);check(160,[320,568]);
    f.canvasCalls.length=0;f.resize(667,375);check(160,[667,375]);
    f.canvasCalls.length=0;f.resize(736,414);check(160,[736,414]);
    f.canvasCalls.length=0;f.resize(...viewport);check();assert.deepEqual(image().slice(1),original);
  }
});

test('normal 2D follows the inclusive CSS mobile breakpoint on initial draw, resize and restore',async()=>{
  for(const width of [759,760,761]){
    const f=await sceneFixture({start:'2d',viewport:[width,900],buildingsFile:null});
    assert(f.canvasCalls.some(call=>call.method==='drawImage'),`initial 2D draw at ${width}px`);
    f.canvasCalls.length=0;f.resize(width,900);
    const draw=f.canvasCalls.findLast(call=>call.method==='drawImage');
    assert(draw,`normal 2D must draw at ${width}px`);
    const [,x,y,w,h]=draw.args;
    assert(w>0&&h>0&&x>=0&&y>=0&&x+w<=width&&y+h<=900);
    for(const id of ['header','side','tools','profile']){
      const r=f.rect(id);
      assert(x+w<=r.left||x>=r.right||y+h<=r.top||y>=r.bottom,`${width}px image intersects ${id}`);
    }
    f.element('maximize-view').onclick();f.canvasCalls.length=0;f.element('maximize-view').onclick();
    assert.deepEqual(f.canvasCalls.findLast(call=>call.method==='drawImage')?.args.slice(1),draw.args.slice(1));
  }
});

test('2D skips drawing when panels leave no space and redraws on resize or closing the card',async()=>{
  const rects={},f=await sceneFixture({start:'2d',viewport:[390,844],buildingsFile:null,rects});
  rects.tools=[12,80,378,425];f.canvasCalls.length=0;f.resize(390,844);
  assert(!f.canvasCalls.some(call=>call.method==='drawImage'));
  assert(f.allElements().filter(el=>el.className?.startsWith('endpoint-marker')).every(el=>el.hidden));
  delete rects.tools;f.resize(390,844);
  assert(f.canvasCalls.some(call=>call.method==='drawImage'));
  assert(f.allElements().some(el=>el.className?.startsWith('endpoint-marker')&&!el.hidden));
  rects['point-card']=[168,80,378,424];f.canvasCalls.length=0;
  f.allElements().find(el=>el.className==='endpoint-marker endpoint-start').onclick();
  assert(!f.canvasCalls.some(call=>call.method==='drawImage'));
  f.element('close-card').onclick();
  assert(f.canvasCalls.some(call=>call.method==='drawImage'),'closing the card must recover an empty map without resize');
});

test('restore is bound before initialization and survives data and fallback image failures',async()=>{
  const f=await sceneFixture({start:'failure',badFetch:true,beforeInit:e=>e('maximize-view').onclick()}),e=f.element;
  assert.match(e('status').textContent,/加载失败/);assert.equal(e('maximize-view').getAttribute('aria-pressed'),'true');
  e('maximize-view').onclick();assert.equal(e('app').classList.contains('maximized'),false);
  const image=await sceneFixture({imageFailure:true});image.element('maximize-view').onclick();
  await assert.rejects(image.flat(),/fixture image failure/);
  image.element('maximize-view').onclick();assert.equal(image.element('maximize-view').textContent,'最大化3D');
  assert.equal(image.element('app').classList.contains('maximized'),false);
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
