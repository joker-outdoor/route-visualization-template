"""Validate generated coordinates, projection, DEM, landmarks and public GPX."""
import argparse, json, math, xml.etree.ElementTree as ET
from pathlib import Path

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
    for lon,lat,e,distance,u,v in p:
        mx=(lon+180)/360;my=(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2
        assert abs((mx-mx0)/(mx1-mx0)-u)<1e-7 and abs((my-my0)/(my1-my0)-v)<1e-7
    assert t['w']>=2 and t['h']>=2 and len(t['elevations'])==t['w']*t['h']
    assert all(math.isfinite(e) for e in t['elevations'])
    assert all(type(m['index']) is int and 0<=m['index']<len(p) and m['positionSource'] for m in d['landmarks'])
    g=ET.parse(directory/'route.gpx').getroot()
    assert {el.tag.split('}')[-1] for el in g.iter()} <= {'gpx','trk','name','trkseg','trkpt','ele'}
    gp=g.findall('.//{*}trkpt');assert len(gp)==len(p)
    assert all(set(x.attrib)=={'lon','lat'} for x in gp)
    for x,a in zip(gp,p):
        assert float(x.attrib['lon'])==a[0] and float(x.attrib['lat'])==a[1] and float(x.find('{*}ele').text)==a[2]
    print(f'PASS: {len(p)} points, distance, projection, DEM, landmarks and GPX privacy')

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--data',type=Path,default=Path(__file__).resolve().parents[1]/'data');check(ap.parse_args().data)
