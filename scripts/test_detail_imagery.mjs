import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three.module.js';
import {sceneFixture} from './test_city_flight.mjs';

const source = await readFile(new URL('../app.js',import.meta.url),'utf8');
const code = source.slice(source.indexOf('function localDataUrl('),source.indexOf('// Interpolate adjacent original points'));
const manifest = {version:1,zoom:17,source:'Esri fixture',patches:Array.from({length:256},(_,i)=>{
  const x=i%16,y=Math.floor(i/16);
  return {file:`imagery-detail/${i}.jpg`,bounds:[x/16,y/16,(x+1)/16,(y+1)/16]};
})};
const flush = () => new Promise(r=>setImmediate(r));

function fixture() {
  const pending=[],textures=[],materials=[];
  let on=true,geometryDisposals=0;
  const world=new THREE.Group(),geometry=new THREE.PlaneGeometry(12,12,1,1);
  geometry.rotateX(-Math.PI/2);geometry.addEventListener('dispose',()=>geometryDisposals++);
  const camera=new THREE.PerspectiveCamera(),controls={target:new THREE.Vector3()};
  camera.position.set(.2,.5,.4);
  const functions=vm.runInNewContext(code+'\n({imageryDetailLayer,imageryManifest,localDataUrl})',{THREE:{...THREE,
    TextureLoader:class{loadAsync(url){return new Promise((resolve,reject)=>pending.push({url,resolve,reject}));}}}});
  const layer=functions.imageryDetailLayer({manifest:functions.imageryManifest(manifest),geometry,world,camera,controls,W:12,H:12,
    renderer:{capabilities:{getMaxAnisotropy:()=>8}},surfaceY:()=>0,enabled:()=>on});
  function resolve(row=pending.shift()) {
    const texture=new THREE.Texture({width:1024,height:1024});texture.disposals=0;
    texture.addEventListener('dispose',()=>texture.disposals++);textures.push(texture);row.resolve(texture);return texture;
  }
  function watchMaterials() {
    for(const mesh of world.children)if(!materials.includes(mesh.material)){
      const m=mesh.material;m.disposals=0;m.addEventListener('dispose',()=>m.disposals++);materials.push(m);
    }
  }
  return {functions,layer,pending,textures,materials,world,geometry,camera,controls,resolve,watchMaterials,
    set enabled(value){on=value;},get geometryDisposals(){return geometryDisposals;}};
}

test('detail manifest rejects external/traversal paths and all malformed patches',()=>{
  const {functions:f}=fixture();assert.equal(f.localDataUrl('imagery-detail/a.jpg'),'data/imagery-detail/a.jpg');
  for(const file of ['https://example.com/a.jpg','//example.com/a.jpg','../x.jpg','imagery-detail/../x.jpg','imagery-detail/%2e%2e/x.jpg','imagery-detail/a.jpg?x','imagery-detail/a\\b.jpg']){
    const bad=structuredClone(manifest);bad.patches[0].file=file;assert.throws(()=>f.imageryManifest(bad));
  }
  for(const changes of [{zoom:true},{version:2},{patches:[]},{source:null},{patches:[...manifest.patches,manifest.patches[0]]}])assert.throws(()=>f.imageryManifest({...manifest,...changes}));
  for(const bounds of [[0,0,NaN,1],[0,0,0,1],[-1,0,1,1],[0,0,1,Infinity]])assert.throws(()=>f.imageryManifest({...manifest,patches:[{file:'imagery-detail/a.jpg',bounds}]}));
});

test('detail loads at most four concurrently and twelve resident meshes; clipping/UV stay north up',async()=>{
  const f=fixture();f.layer.update(0);assert.equal(f.pending.length,4);
  for(let batch=0;batch<3;batch++){
    assert.equal(f.pending.length,4);for(let i=0;i<4;i++)f.resolve();await flush();
    assert(f.world.children.length+f.pending.length<=12);f.watchMaterials();
  }
  assert.equal(f.world.children.length,12);assert.equal(f.pending.length,0);
  f.layer.update(1000);assert.equal(f.pending.length,0);
  for(const mesh of f.world.children){
    assert.equal(mesh.geometry,f.geometry);assert(mesh.material.polygonOffset);
    const tex=mesh.material.map,p=manifest.patches.find(p=>Math.abs(tex.offset.x+p.bounds[0]*16)<1e-9 && Math.abs(tex.offset.y+(1-p.bounds[3])*16)<1e-9);
    assert(p);const [u0,v0,u1,v1]=p.bounds;
    assert(Math.abs(u0*tex.repeat.x+tex.offset.x)<1e-9);assert(Math.abs(u1*tex.repeat.x+tex.offset.x-1)<1e-9);
    assert(Math.abs((1-v0)*tex.repeat.y+tex.offset.y-1)<1e-9);assert(Math.abs((1-v1)*tex.repeat.y+tex.offset.y)<1e-9);
    const center=new THREE.Vector3(((u0+u1)/2-.5)*12,0,((v0+v1)/2-.5)*12);
    assert(mesh.material.clippingPlanes.every(p=>p.distanceToPoint(center)>=0));
    assert(mesh.material.clippingPlanes.some(p=>p.distanceToPoint(center.clone().add(new THREE.Vector3(2,0,0)))<0));
  }
  const oldTextures=f.textures.slice(),oldMaterials=f.materials.slice();
  f.controls.target.set(4,0,4);f.camera.position.set(4.2,.5,4.4);f.layer.update(1300);
  assert.equal(f.world.children.length,0);assert.equal(f.pending.length,4);
  assert(oldTextures.every(t=>t.disposals===1));assert(oldMaterials.every(m=>m.disposals===1));
  f.layer.stop();assert.equal(f.world.children.length,0);assert.equal(f.geometryDisposals,0);
  while(f.pending.length)f.resolve();await flush();
  assert(f.textures.every(t=>t.disposals===1));assert(f.materials.every(m=>m.disposals===1));
});

test('pan, throttling, eviction, late arrivals and texture toggle keep resources bounded',async()=>{
  const f=fixture();f.layer.update(0);const old=f.pending.splice(0);
  f.controls.target.set(4,0,4);f.camera.position.set(4.2,.5,4.4);
  f.layer.update(100);assert.equal(f.pending.length,0); // selection is throttled
  f.layer.update(300);assert.equal(f.pending.length,0); // old requests still own concurrency slots
  const late=old.map(row=>f.resolve(row));await flush();assert(late.every(t=>t.disposals===1));assert.equal(f.world.children.length,0);
  assert.equal(f.pending.length,4);for(let i=0;i<4;i++)f.resolve();await flush();f.watchMaterials();
  assert.equal(f.world.children.length,4);
  f.enabled=false;f.layer.clear();assert.equal(f.world.children.length,0);
  f.enabled=true;f.layer.update(600);const stale=f.pending.splice(0).map(row=>f.resolve(row));await flush();
  assert(stale.every(t=>t.disposals===1));assert(f.pending.length<=4);
  for(let i=0,n=f.pending.length;i<n;i++)f.resolve();await flush();f.watchMaterials();
  f.camera.position.y=10;f.layer.update(900);assert.equal(f.world.children.length,0);
  while(f.pending.length)f.resolve();await flush();assert(f.textures.every(t=>t.disposals===1));
  assert(f.materials.every(m=>m.disposals===1));assert.equal(f.geometryDisposals,0);
});

test('a failed patch stays on the overview without endless retries or blocked queue',async()=>{
  const f=fixture();f.layer.update(0);const failed=f.pending.shift();failed.reject(new Error('offline'));
  await flush();assert.equal(f.pending.length,4);assert(f.pending.every(p=>p.url!==failed.url));
  f.layer.update(1000);assert.equal(f.pending.length,4);f.layer.stop();
  while(f.pending.length)f.resolve();await flush();assert.equal(f.world.children.length,0);
  assert(f.textures.every(t=>t.disposals===1));
});

test('actual app skips absent/unsafe manifests, tolerates invalid data and controls detail with texture button',async()=>{
  const old=await sceneFixture({buildingsFile:null});assert.equal(old.fetches,0);
  const unsafe=await sceneFixture({buildingsFile:null,imageryDetailFile:'../escape.json'});assert.equal(unsafe.fetches,0);
  const invalid=await sceneFixture({buildingsFile:null,detailManifest:{version:99}});assert.equal(invalid.fetches,1);
  assert.equal(invalid.scene.getObjectsByProperty('name','imagery-detail').length,0);
  for(const viewport of [[1200,900],[390,844]]){
    const f=await sceneFixture({buildingsFile:null,detailManifest:manifest,viewport});
    assert.equal(f.fetches,1);assert.equal(f.scene.getObjectsByProperty('name','imagery-detail').length,0);
    f.element('flight-progress').value='500';f.element('flight-progress').oninput();f.step(300);await flush();f.step(600);
    assert(f.scene.getObjectsByProperty('name','imagery-detail').length>0);
    assert(f.scene.getObjectsByProperty('name','imagery-detail').length<=12);
    f.element('texture').onclick();assert.equal(f.scene.getObjectsByProperty('name','imagery-detail').length,0);
    f.step(900);await flush();assert.equal(f.scene.getObjectsByProperty('name','imagery-detail').length,0);
  }
});
