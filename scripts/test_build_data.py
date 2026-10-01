import tempfile, unittest, xml.etree.ElementTree as ET
from pathlib import Path
from build_data import parse_track, build
from check_data import check

class RouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=Path(self.tmp.name)/'source.gpx'
        self.config={'title':'边界测试','madeOn':'2026-10-02'}
    def write(self,ele=True,segments=1,namespace='http://www.topografix.com/GPX/1/1'):
        g=ET.Element('gpx',xmlns=namespace);ET.SubElement(ET.SubElement(g,'metadata'),'author').text='PRIVATE ACCOUNT'
        for n in range(segments):
            s=ET.SubElement(ET.SubElement(g,'trk'),'trkseg')
            for i in range(3):
                p=ET.SubElement(s,'trkpt',lon=str(104+i*.001),lat=str(30+i*.001))
                if ele: ET.SubElement(p,'ele').text='-20'
                ET.SubElement(p,'time').text=f'2025-12-31T12:0{i}:00Z'
        ET.ElementTree(g).write(self.p,encoding='utf-8')
    def test_optional_statistics_privacy_and_flat_elevation(self):
        self.write();d=build(self.p,self.config,Path(self.tmp.name)/'data',True)
        self.assertIsNone(d['stats']['gainM']);self.assertEqual(d['stats']['durationHours'],2/60)
        self.assertEqual(d['recordedOn'],'2025-12-31');self.assertEqual(d['stats']['minM'],-20)
        self.assertNotIn(b'PRIVATE',(Path(self.tmp.name)/'data/route.gpx').read_bytes());check(Path(self.tmp.name)/'data')
    def test_gpx10_and_explicit_landmark(self):
        self.write(namespace='http://www.topografix.com/GPX/1/0');self.config['landmarks']=[{'name':'入口','lon':104.001,'lat':30.001,'positionSource':'用户坐标'}]
        self.assertEqual(parse_track(self.p,self.config)['landmarks'][0]['index'],1)
    def test_missing_elevation_and_disconnected_segments_rejected(self):
        self.write(ele=False)
        with self.assertRaisesRegex(ValueError,'elevation'): parse_track(self.p,self.config)
        self.write(segments=2)
        with self.assertRaisesRegex(ValueError,'continuous'): parse_track(self.p,self.config)
    def test_unlocated_landmark_and_unsourced_statistics_rejected(self):
        self.write();self.config['landmarks']=[{'name':'湖泊','positionSource':'用户顺序'}]
        with self.assertRaisesRegex(ValueError,'explicit'): parse_track(self.p,self.config)
        self.config.pop('landmarks');self.config['stats']={'gainM':100}
        with self.assertRaisesRegex(ValueError,'statsSource'): parse_track(self.p,self.config)
    def test_track_extensions_precedence_and_root_fallback(self):
        self.write();g=ET.parse(self.p).getroot();trk=g.find('{*}trk');te=ET.SubElement(trk,'extensions');re=ET.SubElement(g,'extensions')
        for key,value in [('ElevationGain','300'),('ElevationLoss','200'),('BeginTime','1000'),('EndTime','3601000'),('PosStartName','入口'),('PosEndName','出口')]:
            ET.SubElement(te,key).text=value
        ET.SubElement(re,'ElevationGain').text='999';ET.SubElement(re,'Distance').text='5000';ET.ElementTree(g).write(self.p)
        d=parse_track(self.p,self.config)
        self.assertEqual(d['stats']['gainM'],300);self.assertEqual(d['stats']['lossM'],200);self.assertEqual(d['stats']['durationHours'],1)
        self.assertEqual(d['stats']['sourceDistanceKm'],5);self.assertEqual((d['startName'],d['finishName']),('入口','出口'))
    def test_long_straight_route_has_renderable_corridor(self):
        self.write();g=ET.parse(self.p).getroot()
        for i,p in enumerate(g.findall('.//{*}trkpt')): p.set('lon','104');p.set('lat',str(30+i*.05))
        ET.ElementTree(g).write(self.p);out=Path(self.tmp.name)/'data';d=build(self.p,self.config,out,True)
        self.assertGreater(d['stats']['distanceKm'],11);self.assertLessEqual(max(d['widthKm']/d['heightKm'],d['heightKm']/d['widthKm']),8);check(out)
    def test_checker_rejects_wrong_ground_scale(self):
        import json
        self.write();out=Path(self.tmp.name)/'data';build(self.p,self.config,out,True);f=out/'route.json';d=json.loads(f.read_text());d['widthKm']*=2;f.write_text(json.dumps(d))
        with self.assertRaises(AssertionError): check(out)
    def test_bad_input_does_not_replace_existing_outputs(self):
        self.write(ele=False);out=Path(self.tmp.name)/'data';out.mkdir();(out/'route.json').write_text('unchanged')
        with self.assertRaises(ValueError): build(self.p,self.config,out,True)
        self.assertEqual((out/'route.json').read_text(),'unchanged')

if __name__=='__main__': unittest.main()
