import { createServer } from 'node:http';
import { readFile, access, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const args=process.argv.slice(2), opts={width:1080,height:1920,fps:30,duration:46};
for(let i=0;i<args.length;i+=2){const key=args[i].replace(/^--/,'');if(!['width','height','fps','duration','output','poster','playwright'].includes(key)||!args[i+1])throw Error('用法：node scripts/render_video.mjs --output /path/route.mp4 [--width 1080 --height 1920 --fps 30 --duration 46 --poster /path/poster.png --playwright /path/playwright/index.mjs]');opts[key]=['width','height','fps','duration'].includes(key)?Number(args[i+1]):args[i+1];}
if(!opts.output)throw Error('--output 必填');
for(const k of ['width','height','fps','duration'])if(!Number.isFinite(opts[k])||opts[k]<=0)throw Error(`${k} 必须为正数`);
if(!Number.isInteger(opts.width)||!Number.isInteger(opts.height)||opts.width%2||opts.height%2||opts.width>3840||opts.height>3840||!Number.isInteger(opts.fps)||opts.fps>60||opts.duration>300||Math.round(opts.duration*opts.fps)<2)throw Error('画幅须为偶数且不超过 3840，帧率为 1–60 整数，时长不超过 300 秒');
for(const executable of ['ffmpeg','ffprobe']){const check=spawnSync(executable,['-version'],{stdio:'ignore'});if(check.error||check.status!==0)throw Error(`${executable} 未安装或不可执行`);}
const output=resolve(opts.output);if(extname(output)!=='.mp4')throw Error('输出必须为 .mp4');
async function refuseExisting(p){try{await access(p);}catch(e){if(e.code==='ENOENT')return;throw e;}throw Error(`已有文件，拒绝覆盖：${p}`);}
await refuseExisting(output);if(opts.poster)await refuseExisting(resolve(opts.poster));await mkdir(dirname(output),{recursive:true});
const {chromium}=await import(opts.playwright?pathToFileURL(resolve(opts.playwright)).href:'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.jpg':'image/jpeg','.css':'text/css'};
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}const data=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]??'application/octet-stream'}).end(data);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,encoder;let encoderLog='';
try{
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:opts.width,height:opts.height},deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${server.address().port}/video.html?capture`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.videoReady||window.videoError,{},{timeout:60000});
  const error=await page.evaluate(()=>window.videoError);if(error)throw Error(error);
  const first=await page.evaluate(d=>window.renderVideoFrame(0,d),opts.duration);const last=await page.evaluate(d=>window.renderVideoFrame(d,d),opts.duration);
  const pointCount=await page.evaluate(()=>window.videoPointCount);
  if(!Number.isInteger(pointCount)||pointCount<2||first.index!==0||first.progress!==0||last.index!==pointCount-1||last.progress!==1||first.km!==0||last.km<=0)throw Error('轨迹起终点校验失败');
  console.log(JSON.stringify({start:first,end:last,width:opts.width,height:opts.height,fps:opts.fps,duration:opts.duration}));
  encoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','image2pipe','-vcodec','png','-framerate',String(opts.fps),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',output],{stdio:['pipe','ignore','pipe']});
  const done=new Promise((r,j)=>{encoder.once('error',j);encoder.once('close',code=>code===0?r():j(Error(`ffmpeg ${code}: ${encoderLog}`)));});
  done.catch(()=>{});encoder.stdin.on('error',()=>{});encoder.stderr.on('data',b=>{encoderLog=(encoderLog+b).slice(-4000);});
  const frames=Math.round(opts.duration*opts.fps);
  for(let i=0;i<frames;i++){
    const seconds=i/(frames-1)*opts.duration;
    await page.evaluate(([t,d])=>window.renderVideoFrame(t,d),[seconds,opts.duration]);
    const frame=await page.screenshot({type:'png'});
    if(encoder.exitCode!==null)throw Error(`ffmpeg 提前退出：${encoderLog}`);
    if(!encoder.stdin.write(frame))await Promise.race([once(encoder.stdin,'drain'),done.then(()=>{throw Error('ffmpeg 提前结束');})]);
    if(opts.poster&&i===Math.floor(frames*.48)){await mkdir(dirname(resolve(opts.poster)),{recursive:true});await page.screenshot({path:resolve(opts.poster)});}
    if(i%opts.fps===0)console.log(`render ${Math.round(i/frames*100)}%`);
  }
  encoder.stdin.end();await done;
  const probe=spawn('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,pix_fmt,nb_frames:format=duration','-of','json',output]);let metadata='';probe.stdout.on('data',b=>metadata+=b);await once(probe,'close');if(probe.exitCode!==0)throw Error('ffprobe 验证失败');
  const m=JSON.parse(metadata),s=m.streams[0];if(s.codec_name!=='h264'||s.pix_fmt!=='yuv420p'||s.width!==opts.width||s.height!==opts.height||Number(s.nb_frames)!==frames||Math.abs(Number(m.format.duration)-frames/opts.fps)>.1)throw Error('视频编码参数验证失败');
  console.log(metadata);console.log(`完成：${output}`);
}finally{if(encoder&&encoder.exitCode===null)encoder.kill('SIGTERM');if(browser)await browser.close();await new Promise(r=>server.close(r));}
