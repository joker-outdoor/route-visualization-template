import * as THREE from 'three';
const $ = id => document.getElementById(id);
const clamp = (x, a=0, b=1) => Math.max(a, Math.min(b,x));
const smooth = x => { x=clamp(x); return x*x*(3-2*x); };
try {
  const read = async path => { const r=await fetch(path); if(!r.ok) throw Error(`${path}: HTTP ${r.status}`); return r.json(); };
  const [D,T]=await Promise.all([read('data/route.json'),read('data/terrain.json')]);
  const points=D.points, lakes=D.landmarks ?? D.lakes ?? [], total=D.stats.distanceKm;
  if(!points?.length || total<=0) throw Error('路线数据为空');
  $('title').textContent=D.title;
  $('subtitle').textContent=`${total.toFixed(2)} km · ${D.stats.gainM == null ? '爬升未提供' : '累计爬升 '+Math.round(D.stats.gainM)+' m'} · ${D.startName} → ${D.finishName}`;
  $('source').textContent=`${D.imageryCredit ?? '卫星影像 © Esri, Maxar, Earthstar Geographics'} · ${D.terrainCredit ?? '高程 SRTM / AWS Terrain Tiles'} · GPX ${D.recordedOn ?? '日期未提供'} / 制作 ${D.madeOn ?? '日期未提供'}。${lakes.length ? (D.landmarkNote ?? '地标为概略位置，里程对应邻近轨迹点。') : ''} 动画按距离推进，用时不代表实际速度。`;
  const renderer=new THREE.WebGLRenderer({canvas:$('map'),antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(innerWidth,innerHeight,false); renderer.setPixelRatio(1); renderer.outputColorSpace=THREE.SRGBColorSpace;
  const scene=new THREE.Scene(); scene.background=new THREE.Color('#091319');
  scene.add(new THREE.HemisphereLight('#f2f7ed','#243e48',1.6));
  const sun=new THREE.DirectionalLight('#fff1d6',1.4);sun.position.set(-5,12,8);scene.add(sun);
  const camera=new THREE.PerspectiveCamera(42,innerWidth/innerHeight,.02,200);
  camera.setViewOffset(innerWidth,innerHeight,0,innerHeight*.10,innerWidth,innerHeight);
  const W=D.widthKm,H=D.heightKm,span=Math.max(W,H),base=Math.min(...T.elevations),exag=2.4;
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
  const ribbonPositions=[],ribbonIndices=[];
  vertices.forEach((p,i)=>{
    const dir=vertices[Math.min(i+1,vertices.length-1)].clone().sub(vertices[Math.max(0,i-1)]);dir.y=0;
    const side=new THREE.Vector3(-dir.z,0,dir.x).normalize().multiplyScalar(span*.0018);
    for(const sign of [-1,1]){const q=p.clone().addScaledVector(side,sign);ribbonPositions.push(q.x,q.y,q.z);}
    if(i){const n=i*2;ribbonIndices.push(n-2,n-1,n,n-1,n+1,n);}
  });
  const ribbon=new THREE.BufferGeometry();ribbon.setAttribute('position',new THREE.Float32BufferAttribute(ribbonPositions,3));ribbon.setIndex(ribbonIndices);
  const traveled=new THREE.Mesh(ribbon,new THREE.MeshBasicMaterial({color:'#b9ef69',depthTest:false,side:THREE.DoubleSide}));traveled.renderOrder=2;scene.add(traveled);
  const marker=new THREE.Mesh(new THREE.SphereGeometry(span*.009,18,12),new THREE.MeshBasicMaterial({color:'#fff',depthTest:false}));marker.renderOrder=4;scene.add(marker);
  const labels=lakes.map((l,i)=>{
    const el=document.createElement('div');el.className='label';
    const b=document.createElement('b');b.textContent=String(i+1);el.append(b,document.createTextNode(l.name));
    const s=document.createElement('span');s.textContent=`${points[l.index][3].toFixed(1)} km`;el.append(s);$('labels').append(el);
    const p=xyz(points[l.index]);p.y+=span*.03;return {el,p,index:l.index};
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
  // Exact GPX polyline interpolation; no spline may cut across switchbacks.
  function locate(km){let l=0,r=points.length-1;while(l<r){const m=(l+r)>>1;if(points[m][3]<km)l=m+1;else r=m;}
    const a=Math.max(0,l-1),den=points[l][3]-points[a][3],t=den>0?clamp((km-points[a][3])/den):0;
    return {index:l,pos:vertices[a].clone().lerp(vertices[l],t),ele:points[a][2]+(points[l][2]-points[a][2])*t};
  }
  const portrait=innerWidth<innerHeight,center=new THREE.Vector3(0,(D.stats.maxM-base)/2000*exag,0);
  const overview=span*(portrait?2.0:1.05),near=span*(portrait?.65:.40);
  window.renderVideoFrame=(seconds,duration=46)=>{
    const t=clamp(seconds/duration),progress=clamp((t-.08)/.84),km=progress*total,p=locate(km);
    const travel=smooth(t/.10)*(1-smooth((t-.90)/.10));
    const target=center.clone().lerp(p.pos,travel*.92),dist=overview+(near-overview)*travel;
    const angle=-.35+t*.9;
    camera.position.copy(target).add(new THREE.Vector3(Math.sin(angle)*dist,dist*.85,Math.cos(angle)*dist));
    camera.lookAt(target);camera.updateMatrixWorld();marker.position.copy(p.pos);traveled.geometry.setDrawRange(0,p.index*6);renderer.render(scene,camera);
    const placed=[];
    labels.forEach(({el,p:pos,index})=>{
      const v=pos.clone().project(camera),x=(v.x+1)*innerWidth/2;let y=(1-v.y)*innerHeight/2;
      const w=el.offsetWidth,h=el.offsetHeight;
      if(v.z<-1||v.z>1||x<w/2+15||x>innerWidth-w/2-15||y<innerHeight*.23||y>innerHeight*.74){el.style.visibility='hidden';return;}
      for(let n=0;n<10;n++){const hit=placed.find(q=>Math.abs(q.x-x)<(q.w+w)/2+8&&Math.abs(q.y-y)<(q.h+h)/2+6);if(!hit)break;y=hit.y-(hit.h+h)/2-8;}
      if(y<innerHeight*.23){el.style.visibility='hidden';return;}
      placed.push({x,y,w,h});el.style.visibility='visible';el.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;el.style.opacity=index<=p.index?'1':'.75';
    });
    $('distance').textContent=km.toFixed(1);$('elevation').textContent=Math.round(p.ele);
    $('phase').textContent=t<.08?'路线全貌':t>.92?'全程抵达 · '+total.toFixed(2)+' km':'沿轨迹飞越';
    const next=[...lakes].sort((a,b)=>points[a.index][3]-points[b.index][3]).find(l=>points[l.index][3]>km);
    $('next').textContent=next?'下一站 '+next.name:progress===1?'终点 '+D.finishName:'前往 '+D.finishName;
    drawProfile(km,p.ele);return {km,index:p.index,ele:p.ele,progress};
  };
  window.renderVideoFrame(0);window.videoReady=true;
  if(!new URLSearchParams(location.search).has('capture')){
    const start=performance.now();function animate(now){window.renderVideoFrame(((now-start)/1000)%46);requestAnimationFrame(animate);}requestAnimationFrame(animate);
  }
}catch(e){$('error').textContent='视频场景加载失败：'+e.message;window.videoError=e.message;}
