"""Build local terrain / imagery and a privacy-minimized GPX from a supplied track."""
import argparse, io, json, math, tempfile, urllib.request, xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image

def merc(lon, lat):
    return (lon + 180) / 360, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2

def distance(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, [a[1], a[0], b[1], b[0]])
    return 12742 * math.asin(min(1, math.sqrt(math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2)))

def download(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Joker-outdoor-route/1.0'})
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.read()

def mosaic(bounds, zoom, kind):
    left, top, right, bottom = [v * (2**zoom) * 256 for v in bounds]
    x0, y0, x1, y1 = math.floor(left/256), math.floor(top/256), math.floor(right/256), math.floor(bottom/256)
    if (x1-x0+1)*(y1-y0+1) > 128: raise ValueError('Tile limit exceeded; lower imageryZoom/demZoom or split this large route')
    coords = [(x,y) for y in range(y0,y1+1) for x in range(x0,x1+1)]
    def tile(c):
        x,y = c
        url = (f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{zoom}/{x}/{y}.png' if kind=='dem' else
               f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{zoom}/{y}/{x}')
        cache=Path(tempfile.gettempdir())/'joker-outdoor-tile-cache'/f'{kind}-{zoom}-{x}-{y}'
        cache.parent.mkdir(exist_ok=True)
        if not cache.exists(): cache.write_bytes(download(url))
        return c,Image.open(io.BytesIO(cache.read_bytes())).convert('RGB')
    image=Image.new('RGB',((x1-x0+1)*256,(y1-y0+1)*256))
    with ThreadPoolExecutor(max_workers=6) as pool:
        for (x,y),im in pool.map(tile,coords): image.paste(im,((x-x0)*256,(y-y0)*256))
    return image,(left-x0*256,top-y0*256,right-x0*256,bottom-y0*256)

def finite(value, name):
    number = float(value)
    if not math.isfinite(number): raise ValueError(f'{name} must be finite')
    return number

def parse_track(gpx, config):
    from datetime import datetime
    root = ET.parse(gpx).getroot()
    segments = root.findall('.//{*}trkseg')
    if len(segments) != 1: raise ValueError('Expected one continuous trkseg; split disconnected GPX segments before rendering')
    pts = []
    times = []
    for p in segments[0].findall('{*}trkpt'):
        lon, lat = finite(p.attrib['lon'], 'longitude'), finite(p.attrib['lat'], 'latitude')
        if not (-180 < lon < 180 and -85 < lat < 85): raise ValueError('Coordinates exceed supported Web Mercator region')
        ele = p.find('{*}ele')
        if ele is None or not ele.text: raise ValueError('GPX elevation is missing; obtain elevations before rendering a profile')
        pts.append([lon, lat, finite(ele.text, 'elevation')])
        stamp = p.find('{*}time')
        if stamp is not None and stamp.text:
            times.append(datetime.fromisoformat(stamp.text.replace('Z', '+00:00')))
    if not 2 <= len(pts) <= 20000: raise ValueError('Expected 2–20000 track points; simplify larger tracks first')
    km = 0
    for i, p in enumerate(pts):
        if i: km += distance(pts[i-1], p)
        p.append(round(km, 6))
    if km <= 0: raise ValueError('Track has zero distance')
    lons, lats = [p[0] for p in pts], [p[1] for p in pts]
    if max(lons)-min(lons) > 5 or max(lats)-min(lats) > 5:
        raise ValueError('Route spans over 5 degrees or crosses the antimeridian; split it into local routes')
    padx, pady = max((max(lons)-min(lons))*.12, .002), max((max(lats)-min(lats))*.12, .002)
    lon0, lon1, lat0, lat1 = min(lons)-padx, max(lons)+padx, min(lats)-pady, max(lats)+pady
    mx0,my1 = merc(lon0,lat0); mx1,my0 = merc(lon1,lat1)
    scale = 40075.016686*math.cos(math.radians((lat0+lat1)/2))
    w,h = (mx1-mx0)*scale, (my1-my0)*scale
    if max(w/h,h/w) > 8: raise ValueError('Very narrow route extent; split it or supply a less elongated track')
    for p in pts:
        x,y = merc(p[0],p[1]); p.extend([round((x-mx0)/(mx1-mx0),8), round((y-my0)/(my1-my0),8)])
    extension = root.find('{*}extensions')
    def ext(key):
        el = extension.find('{*}'+key) if extension is not None else None
        return el.text if el is not None else None
    def optional(key):
        val = ext(key)
        return finite(val,key) if val else None
    stats = {'distanceKm':km, 'sourceDistanceKm':optional('Distance'), 'gainM':optional('ElevationGain'),
             'lossM':optional('ElevationLoss'), 'minM':min(p[2] for p in pts), 'maxM':max(p[2] for p in pts), 'durationHours':None}
    if stats['sourceDistanceKm'] is not None: stats['sourceDistanceKm'] /= 1000
    begin,end = optional('BeginTime'),optional('EndTime')
    if begin is not None and end is not None and end >= begin: stats['durationHours'] = (end-begin)/3600000
    elif len(times)==len(pts):
        if any(a>b for a,b in zip(times,times[1:])): raise ValueError('Track timestamps must be ordered')
        stats['durationHours'] = (times[-1]-times[0]).total_seconds()/3600
    # Explicit editorial statistics have a separately displayed source, not fabricated GPX metadata.
    overrides = config.get('stats', {})
    if overrides and not config.get('statsSource'): raise ValueError('statsSource required for configured statistics')
    for key,val in overrides.items():
        if key not in ('gainM','lossM','durationHours','sourceDistanceKm'): raise ValueError(f'Unsupported statistics override: {key}')
        stats[key] = finite(val,key) if val is not None else None
    if any(v is not None and v < 0 for k,v in stats.items() if k not in ('minM','maxM')):
        raise ValueError('Distance, duration, gain and loss cannot be negative')
    from datetime import date
    made = config.get('madeOn')
    if not made: raise ValueError('madeOn is required; never infer an activity date from the filename')
    date.fromisoformat(made)
    recorded = config.get('recordedOn', times[0].date().isoformat() if times else None)
    if recorded: date.fromisoformat(recorded)
    data = {'title':config['title'], 'subtitle':config.get('subtitle',''), 'routeLabel':config.get('routeLabel','单线 GPX 路线'),
            'madeOn':made, 'recordedOn':recorded, 'points':pts, 'stats':stats,
            'statsSource':config.get('statsSource','GPX 扩展字段或完整时间记录；缺失项未提供'),
            'startName':config.get('startName',ext('PosStartName') or '起点'), 'finishName':config.get('finishName',ext('PosEndName') or '终点'),
            'bounds':{'lon0':lon0,'lon1':lon1,'lat0':lat0,'lat1':lat1,'mercator':[mx0,my0,mx1,my1]}, 'widthKm':w,'heightKm':h,
            'landmarkTitle':config.get('landmarkTitle','沿途地标'), 'landmarkNote':config.get('landmarkNote','标注里程对应邻近轨迹点，点击查看位置。'),
            'imageryCredit':'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
            'terrainCredit':'Terrain · Mapzen; SRTM / GMTED2010 courtesy of USGS', 'landmarks':[]}
    if not isinstance(data['title'],str) or not data['title'].strip(): raise ValueError('title must be a nonempty string')
    for mark in config.get('landmarks',[]):
        if not isinstance(mark.get('name'),str) or not mark['name'].strip() or not mark.get('positionSource'):
            raise ValueError('Each landmark needs name and positionSource')
        if 'index' in mark:
            idx=mark['index']
            if type(idx) is not int or not 0 <= idx < len(pts): raise ValueError('Landmark index outside track')
        elif 'lon' in mark and 'lat' in mark:
            lon,lat=finite(mark['lon'],'landmark longitude'),finite(mark['lat'],'landmark latitude')
            if not -180 <= lon <= 180 or not -85 <= lat <= 85: raise ValueError('Invalid landmark coordinates')
            idx=min(range(len(pts)),key=lambda i:distance(pts[i],[lon,lat]))
        else: raise ValueError('Landmark requires an explicit track index or lon/lat; names alone do not locate it')
        data['landmarks'].append({'name':mark['name'],'index':idx,'positionSource':mark['positionSource']})
    return data

def terrain_data(bounds,w,h,zoom):
    dem,box=mosaic(bounds,zoom,'dem');longest=181
    gw=max(3,round(longest*min(1,w/h)));gh=max(3,round(longest*min(1,h/w)))
    pix=dem.load();elev=[]
    for y in range(gh):
        for x in range(gw):
            px=box[0]+x/(gw-1)*(box[2]-box[0]);py=box[1]+y/(gh-1)*(box[3]-box[1]);ix,iy=math.floor(px),math.floor(py);fx,fy=px-ix,py-iy
            def el(dx,dy):
                r,g,b=pix[min(ix+dx,dem.width-1),min(iy+dy,dem.height-1)];return r*256+g+b/256-32768
            v=el(0,0)*(1-fx)*(1-fy)+el(1,0)*fx*(1-fy)+el(0,1)*(1-fx)*fy+el(1,1)*fx*fy
            elev.append(round(v,1))
    return {'w':gw,'h':gh,'elevations':elev}

def public_gpx(data):
    g=ET.Element('gpx',version='1.1',creator='Joker Outdoor',xmlns='http://www.topografix.com/GPX/1/1')
    trk=ET.SubElement(g,'trk');ET.SubElement(trk,'name').text=data['title'];seg=ET.SubElement(trk,'trkseg')
    for lon,lat,e,*_ in data['points']:
        p=ET.SubElement(seg,'trkpt',lat=str(lat),lon=str(lon));ET.SubElement(p,'ele').text=str(e)
    result=io.BytesIO();ET.ElementTree(g).write(result,encoding='utf-8',xml_declaration=True)
    return result.getvalue()

def build(gpx,config,out,demo=False):
    data=parse_track(gpx,config);w,h=data['widthKm'],data['heightKm'];bounds=data['bounds']['mercator']
    size=(max(1,round(1200*min(1,w/h))),max(1,round(1200*min(1,h/w))))
    if demo:
        from PIL import ImageDraw
        image=Image.new('RGB',size,'#294d44');draw=ImageDraw.Draw(image)
        for y in range(0,size[1],30): draw.line([(0,y),(size[0],y)],fill='#386251')
        for x in range(0,size[0],30): draw.line([(x,0),(x,size[1])],fill='#386251')
        terrain={'w':61,'h':61,'elevations':[round(500+180*math.sin(x/60*math.pi)*math.sin(y/60*math.pi),1) for y in range(61) for x in range(61)]}
        data['imageryCredit']='合成网格底图 · 演示数据';data['terrainCredit']='合成地形 · 不代表真实地貌'
    else:
        z=config.get('imageryZoom',14);dz=config.get('demZoom',12)
        if type(z) is not int or type(dz) is not int or not 0 <= z <= 18 or not 0 <= dz <= 15: raise ValueError('Invalid tile zoom')
        image,box=mosaic(bounds,z,'sat');image=image.transform(size,Image.Transform.EXTENT,box,Image.Resampling.BICUBIC)
        terrain=terrain_data(bounds,w,h,dz)
    satellite=io.BytesIO();image.save(satellite,format='JPEG',quality=90)
    outputs={'route.json':json.dumps(data,ensure_ascii=False,separators=(',',':')).encode(),
             'terrain.json':json.dumps(terrain,separators=(',',':')).encode(), 'satellite.jpg':satellite.getvalue(), 'route.gpx':public_gpx(data)}
    # Input parsing and all network work finish before any published data is replaced.
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    for name,content in outputs.items(): (out/name).write_bytes(content)
    return data

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('gpx',type=Path);ap.add_argument('--config',type=Path,required=True)
    ap.add_argument('--output',type=Path,required=True);ap.add_argument('--demo',action='store_true',help='Use explicitly labelled synthetic imagery and terrain; no network')
    a=ap.parse_args();config=json.loads(a.config.read_text());data=build(a.gpx,config,a.output,a.demo)
    print(json.dumps({'points':len(data['points']),'stats':data['stats'],'output':str(a.output)},ensure_ascii=False))

if __name__=='__main__': main()
