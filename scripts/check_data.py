"""Validate generated coordinates, projection, DEM, landmarks and public GPX."""
import argparse, json, math, xml.etree.ElementTree as ET
from pathlib import Path

HEIGHT_SOURCES = {'osm-height', 'osm-levels', 'osm-estimate', 'default-estimate'}

def validate_buildings(data):
    """Shared input/output contract; fail before the generator replaces any files."""
    def require(ok, message):
        if not ok: raise ValueError('Invalid buildings: ' + message)
    def finite(value):
        return type(value) in (int, float) and math.isfinite(value)
    require(isinstance(data, dict) and type(data.get('version')) is int and data['version'] == 1, 'version must be 1')
    source = data.get('source')
    require(isinstance(source, dict), 'source is required')
    for key in ('name', 'url', 'license', 'extractedOn'):
        require(isinstance(source.get(key), str) and bool(source[key].strip()), 'source.' + key)
    require(finite(source.get('corridorMeters')) and source['corridorMeters'] > 0, 'corridorMeters')
    require(isinstance(data.get('heightNote'), str) and bool(data['heightNote'].strip()), 'heightNote')
    require(isinstance(data.get('buildings'), list), 'buildings array')
    for i, b in enumerate(data['buildings']):
        label = f'building {i}'
        require(isinstance(b, dict), label)
        require(isinstance(b.get('id'), str) and bool(b['id']), label + ' id')
        ring = b.get('ring')
        require(isinstance(ring, list) and len(ring) >= 3, label + ' ring')
        require(all(isinstance(p, list) and len(p) == 2 and all(finite(v) for v in p)
                    and -180 <= p[0] <= 180 and -85.051129 <= p[1] <= 85.051129 for p in ring), label + ' coordinates')
        require(len(set(map(tuple, ring))) >= 3 and ring[0] != ring[-1], label + ' distinct unclosed ring')
        # Translate to the first vertex to avoid cancellation for tiny WGS84 footprints.
        x, y = ring[0]
        area = sum((a[0]-x)*(b[1]-y)-(b[0]-x)*(a[1]-y) for a, b in zip(ring, ring[1:]+ring[:1]))
        require(abs(area) > 1e-16, label + ' zero area')
        low, high = b.get('minHeightM'), b.get('heightM')
        require(finite(low) and finite(high) and 0 <= low < high <= 1000, label + ' height')
        require(isinstance(b.get('heightSource'), str) and b['heightSource'] in HEIGHT_SOURCES, label + ' heightSource')
        require(type(b.get('part')) is bool, label + ' part')
        for key in ('name', 'color', 'note'):
            require(key not in b or isinstance(b[key], str), label + ' ' + key)
    return data

def buildings_path(directory, filename):
    if not isinstance(filename, str) or not filename or Path(filename).is_absolute() or '\\' in filename:
        raise ValueError('buildingsFile must be a file inside data')
    root = directory.resolve()
    path = (root / filename).resolve()
    if '..' in Path(filename).parts or not path.is_relative_to(root) or path == root:
        raise ValueError('buildingsFile must be a file inside data')
    return path

def check(directory):
    d=json.loads((directory/'route.json').read_text());t=json.loads((directory/'terrain.json').read_text());p=d['points']
    assert len(p)>=2 and p[0][3]==0
    assert all(len(row)==6 and all(math.isfinite(v) for v in row) for row in p)
    assert all(0<=row[4]<=1 and 0<=row[5]<=1 for row in p)
    assert all(a[3]<=b[3] for a,b in zip(p,p[1:]))
    km=0
    for a,b in zip(p,p[1:]):
        la,lb=math.radians(a[1]),math.radians(b[1]);h=math.sin((lb-la)/2)**2+math.cos(la)*math.cos(lb)*math.sin(math.radians(b[0]-a[0])/2)**2
        km+=12742*math.asin(min(1,math.sqrt(h)))
    assert km>0 and abs(km-d['stats']['distanceKm'])<1e-8 and abs(km-p[-1][3])<1e-6
    mx0,my0,mx1,my1=d['bounds']['mercator']
    scale=40075.016686*math.cos(math.radians((d['bounds']['lat0']+d['bounds']['lat1'])/2))
    assert abs(d['widthKm']-(mx1-mx0)*scale)<1e-8
    assert abs(d['heightKm']-(my1-my0)*scale)<1e-8
    for lon,lat,e,distance,u,v in p:
        mx=(lon+180)/360;my=(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2
        assert abs((mx-mx0)/(mx1-mx0)-u)<1e-7 and abs((my-my0)/(my1-my0)-v)<1e-7
    assert t['w']>=2 and t['h']>=2 and len(t['elevations'])==t['w']*t['h']
    assert all(math.isfinite(e) for e in t['elevations'])
    assert all(type(m['index']) is int and 0<=m['index']<len(p) and m['positionSource'] for m in d['landmarks'])
    if 'buildingsFile' in d:
        validate_buildings(json.loads(buildings_path(directory, d['buildingsFile']).read_text()))
    if 'speedMps' in d:
        assert d['speedUnit']=='m/s' and d['speedSource']
        assert len(d['speedMps'])==len(p) and len(d['speedState'])==len(p)
        for speed,state in zip(d['speedMps'],d['speedState']):
            assert state in {'moving','stopped','missing','gap'}
            assert speed is None or (type(speed) in (float,int) and math.isfinite(speed) and speed>=0)
            assert (speed is None)==(state in {'missing','gap'})
    stats=d['stats']
    if stats.get('movingSeconds') is not None:
        assert 0<=stats['pauseSeconds']<=stats['durationHours']*3600
        assert abs(stats['movingSeconds']+stats['pauseSeconds']-stats['durationHours']*3600)<1e-6
        if stats['movingSeconds']>0 and stats['paceDistanceKm']>0:
            assert math.isfinite(stats['avgPaceSecondsKm']) and stats['avgPaceSecondsKm']>0
            assert abs(stats['avgPaceSecondsKm']*stats['paceDistanceKm']-stats['movingSeconds'])<1e-6
    g=ET.parse(directory/'route.gpx').getroot()
    assert {el.tag.split('}')[-1] for el in g.iter()} <= {'gpx','trk','name','trkseg','trkpt','ele'}
    gp=g.findall('.//{*}trkpt');assert len(gp)==len(p)
    assert all(set(x.attrib)=={'lon','lat'} for x in gp)
    for x,a in zip(gp,p):
        assert float(x.attrib['lon'])==a[0] and float(x.attrib['lat'])==a[1] and float(x.find('{*}ele').text)==a[2]
    print(f'PASS: {len(p)} points, distance, projection, DEM, landmarks and GPX privacy')

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--data',type=Path,default=Path(__file__).resolve().parents[1]/'data');check(ap.parse_args().data)
