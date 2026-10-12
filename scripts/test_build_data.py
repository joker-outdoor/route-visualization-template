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

class MotionTests(unittest.TestCase):
    setUp = RouteTests.setUp
    write = RouteTests.write
    def kml(self, exporter='TbuluKmlVersion2', summary=None, coords=None, stamps=None):
        root=ET.Element('kml',xmlns='http://www.opengis.net/kml/2.2')
        doc=ET.SubElement(root,'Document',id=exporter)
        ET.SubElement(doc,'name').text='PRIVATE ACCOUNT / AVATAR'
        ext=ET.SubElement(doc,'ExtendedData')
        for key,value in (summary or {}).items():
            ET.SubElement(ET.SubElement(ext,'Data',name=key),'value').text=str(value)
        for _ in range(2): ET.SubElement(ET.SubElement(doc,'Placemark'),'Point')
        track=ET.SubElement(ET.SubElement(doc,'Placemark'),'{http://www.google.com/kml/ext/2.2}Track')
        for stamp in stamps if stamps is not None else ['2026-10-11T10:13:15Z','2026-10-11T10:13:17Z','2026-10-11T10:13:19Z']:
            ET.SubElement(track,'when').text=stamp
        for row in coords or [(120.15,30.26,10),(120.1501,30.26,11),(120.1502,30.26,12)]:
            ET.SubElement(track,'{http://www.google.com/kml/ext/2.2}coord').text=' '.join(map(str,row))
        extra=ET.SubElement(track,'ExtendedData')
        ET.SubElement(ET.SubElement(extra,'Data',name='GxTrackExtendedData'),'value').text='unknown-private-columns'
        ET.ElementTree(root).write(self.p,encoding='utf-8')
    def test_kml_motion_summary_and_public_privacy(self):
        import json
        self.kml(summary={'Distance':21756.42946997522,'ElevationGain':141.3082070946693,'ElevationLoss':138.7340660560876,
                          'BeginTime':1791713594856,'EndTime':1791721942966,'PauseTime':480741,'SportAvgSpeed':2.765401045770794})
        d=build(self.p,self.config,Path(self.tmp.name)/'data',True)
        self.assertEqual(len(d['points']),3)
        self.assertAlmostEqual(d['stats']['movingSeconds'],7867.369)
        self.assertAlmostEqual(d['stats']['avgPaceSecondsKm'],361.6112198399695)
        self.assertAlmostEqual(d['stats']['avgSpeedMps'],2.765401045770794)
        self.assertEqual(d['stats']['paceDistanceKm'],d['stats']['sourceDistanceKm'])
        self.assertIsNone(d['speedMps'][0]);self.assertGreater(d['speedMps'][1],4)
        public=json.dumps(d)+ (Path(self.tmp.name)/'data/route.gpx').read_text()
        for secret in ['PRIVATE ACCOUNT','AVATAR','unknown-private-columns','2026-10-11T','BeginTime','EndTime']:
            self.assertNotIn(secret,public)
        check(Path(self.tmp.name)/'data')
    def test_unknown_kml_exporter_pause_unit_is_not_guessed(self):
        self.kml(exporter='Other',summary={'PauseTime':1,'SportAvgSpeed':999,'Distance':100})
        d=parse_track(self.p,self.config)
        self.assertIsNone(d['stats']['pauseSeconds']);self.assertIsNone(d['stats']['movingSeconds']);self.assertIsNone(d['stats']['avgPaceSecondsKm'])
        self.assertEqual(d['stats']['durationHours'],4/3600)
    def test_gpx_pause_unit_requires_explicit_sourced_seconds(self):
        self.write();g=ET.parse(self.p).getroot();ET.SubElement(ET.SubElement(g.find('{*}trk'),'extensions'),'PauseTime').text='1000';ET.ElementTree(g).write(self.p)
        self.assertIsNone(parse_track(self.p,self.config)['stats']['pauseSeconds'])
        self.config.update(stats={'pauseSeconds':20},statsSource='verified GPX pause unit: 20 seconds')
        d=parse_track(self.p,self.config)
        self.assertAlmostEqual(d['stats']['movingSeconds'],100)
        self.assertEqual(d['movingTimeSource'],self.config['statsSource'])
    def test_missing_times_and_long_intervals_keep_point_alignment(self):
        coords=[(120.15+i*.00001,30.26,10) for i in range(6)]
        # A missing value invalidates both adjacent intervals; a zero interval is unknown too.
        self.kml(coords=coords,stamps=['2026-10-11T00:00:00Z',None,'2026-10-11T00:00:04Z','2026-10-11T00:00:44Z','2026-10-11T00:00:44Z','2026-10-11T00:00:46Z'])
        d=parse_track(self.p,self.config)
        self.assertEqual(len(d['speedMps']),6)
        self.assertEqual(d['speedState'],['missing','missing','missing','gap','missing','stopped'])
        self.assertEqual(d['speedMps'][:5],[None]*5);self.assertGreater(d['speedMps'][5],0)
        self.assertIsNone(d['stats']['durationHours'])
    def test_gpx_partial_times_do_not_shift_speed_samples(self):
        self.write();g=ET.parse(self.p).getroot();middle=g.findall('.//{*}trkpt')[1];middle.remove(middle.find('{*}time'));ET.ElementTree(g).write(self.p)
        d=parse_track(self.p,self.config)
        self.assertEqual(d['speedMps'],[None,None,None]);self.assertIsNone(d['stats']['durationHours'])
    def test_kml_timestamp_count_and_order_rejected(self):
        self.kml(stamps=['2026-10-11T00:00:00Z'])
        with self.assertRaisesRegex(ValueError,'align'): parse_track(self.p,self.config)
        self.kml(stamps=['2026-10-11T00:00:02Z','2026-10-11T00:00:01Z','2026-10-11T00:00:00Z'],summary={'BeginTime':1000,'EndTime':5000})
        with self.assertRaisesRegex(ValueError,'ordered'): parse_track(self.p,self.config)
    def test_kml_multiple_tracks_and_missing_elevation_rejected(self):
        self.kml();g=ET.parse(self.p).getroot();ET.SubElement(g,'{http://www.google.com/kml/ext/2.2}Track');ET.ElementTree(g).write(self.p)
        with self.assertRaisesRegex(ValueError,'continuous'): parse_track(self.p,self.config)
        self.kml(coords=[(120.15,30.26),(120.16,30.26),(120.17,30.26)])
        with self.assertRaisesRegex(ValueError,'elevation'): parse_track(self.p,self.config)
    def test_pause_invalid_units_and_conflicting_average_rejected(self):
        for pause in [-1,5000,'NaN']:
            self.kml(summary={'BeginTime':1000,'EndTime':5000,'PauseTime':pause})
            with self.assertRaises(ValueError): parse_track(self.p,self.config)
        self.kml(summary={'Distance':100,'BeginTime':1000,'EndTime':5000,'PauseTime':0,'SportAvgSpeed':999})
        with self.assertRaisesRegex(ValueError,'disagrees'): parse_track(self.p,self.config)
        self.kml(summary={'Distance':100,'BeginTime':1000,'EndTime':5000,'PauseTime':4000})
        d=parse_track(self.p,self.config)
        self.assertEqual(d['stats']['movingSeconds'],0);self.assertIsNone(d['stats']['avgPaceSecondsKm'])
    def test_no_time_input_has_null_speeds_and_unknown_motion(self):
        self.kml(stamps=[]);d=parse_track(self.p,self.config)
        self.assertEqual(d['speedMps'],[None]*3)
        self.assertEqual(d['speedState'],['missing']*3)
        self.assertIsNone(d['stats']['movingSeconds'])
    def test_checker_rejects_speed_array_drift(self):
        import json
        self.kml();out=Path(self.tmp.name)/'data';build(self.p,self.config,out,True)
        f=out/'route.json';d=json.loads(f.read_text());d['speedMps'].pop();f.write_text(json.dumps(d))
        with self.assertRaises(AssertionError): check(out)

if __name__=='__main__': unittest.main()
