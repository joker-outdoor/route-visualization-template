import io, json, math, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image, ImageDraw
import build_data as builder
from check_data import check, validate_imagery_detail


def native_mosaic(bounds, zoom, kind):
    scale = 2**zoom*256
    w, h = [max(1, round((bounds[i+2]-bounds[i])*scale)) for i in range(2)]
    image = Image.new('RGB', (w, h), '#46825c')
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, w-1, h//2-1), fill='#c02020')
    return image, (0, 0, w, h)


class DetailImageryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.gpx = self.root/'track.gpx'; self.out = self.root/'data'
        self.config = {'title':'高清测试', 'madeOn':'2026-10-24'}
        self.track()

    def track(self, end=104.02):
        self.gpx.write_text(f'<gpx><trk><trkseg><trkpt lon="104" lat="30"><ele>500</ele></trkpt>'
                            f'<trkpt lon="{end}" lat="30"><ele>500</ele></trkpt></trkseg></trk></gpx>')

    def build(self):
        with patch.object(builder, 'mosaic', native_mosaic), patch.object(builder, 'terrain_data', return_value={'w':2,'h':2,'elevations':[500]*4}):
            return builder.build(self.gpx, dict(self.config, detailImageryZoom=17), self.out)

    def snapshot(self):
        return {p.relative_to(self.out).as_posix():p.read_bytes() for p in self.out.rglob('*') if p.is_file()}

    def test_optional_default_and_invalid_zoom_do_not_download(self):
        with patch.object(builder, 'mosaic', side_effect=AssertionError('unexpected network')):
            d = builder.build(self.gpx, self.config, self.out, demo=True)
            self.assertNotIn('imageryDetailFile', d)
            for zoom in (True, False, 14, 19, 17.0, '17', None):
                with self.subTest(zoom=zoom), self.assertRaises(ValueError):
                    builder.build(self.gpx, dict(self.config, detailImageryZoom=zoom), self.out)
            with self.assertRaisesRegex(ValueError, 'real imagery'):
                builder.build(self.gpx, dict(self.config, detailImageryZoom=17), self.out, demo=True)

    def test_sparse_segment_covers_middle_and_600m_corridor(self):
        self.track(104.2)
        d = builder.parse_track(self.gpx, self.config); patches = builder.detail_patches(d, 17)
        mx0, my0, mx1, my1 = d['bounds']['mercator']; scale = d['widthKm']/(mx1-mx0)
        a, b = [builder.merc(p[0],p[1]) for p in d['points']]
        self.assertLessEqual(len(patches), 256)
        for i in range(101):
            x, y = a[0]+(b[0]-a[0])*i/100, a[1]
            for offset in (-.6, 0, .6):
                self.assertTrue(any(l <= x <= r and t <= y+offset/scale <= bot for _,_,(l,t,r,bot) in patches))
        self.track(105.2)
        with patch.object(builder, 'mosaic', side_effect=AssertionError('must limit before downloads')):
            with self.assertRaisesRegex(ValueError, 'limit exceeded'):
                builder.build(self.gpx, dict(self.config, detailImageryZoom=18), self.out)
        empty = dict(d, points=[])
        with self.assertRaisesRegex(ValueError, 'No detail'): builder.detail_patches(empty,17)

    def test_native_blocks_cropped_bounds_north_up_and_data_checker(self):
        self.track(104.1)
        d = self.build(); manifest = json.loads((self.out/d['imageryDetailFile']).read_text())
        check(self.out)
        sizes = []
        for p in manifest['patches']:
            with Image.open(self.out/p['file']) as image: sizes.append(image.size)
        self.assertIn((1024,1024), sizes)
        self.assertTrue(any(w < 1024 or h < 1024 for w,h in sizes))
        pixels = 2**17*256; mx0,my0,mx1,my1 = d['bounds']['mercator']
        for row in manifest['patches']:
            u0,v0,u1,v1 = row['bounds']
            with Image.open(self.out/row['file']) as im:
                self.assertEqual(im.size, (max(1,round((u1-u0)*(mx1-mx0)*pixels)),max(1,round((v1-v0)*(my1-my0)*pixels))))
                if im.size == (1024,1024):
                    self.assertGreater(im.getpixel((512,10))[0], 150)
                    self.assertGreater(im.getpixel((512,1010))[1], 100)
        with Image.open(self.out/'satellite.jpg') as image: self.assertEqual(max(image.size), 1200)

    def test_manifest_rejects_bad_paths_bounds_empty_and_images(self):
        self.build(); original = json.loads((self.out/'imagery-detail.json').read_text())
        for filename in ('../outside.jpg','/tmp/a.jpg','https://example.com/a.jpg','imagery-detail/../a.jpg','imagery-detail/%2e%2e/a.jpg'):
            bad = json.loads(json.dumps(original)); bad['patches'][0]['file'] = filename
            with self.assertRaises(ValueError): validate_imagery_detail(bad, self.out)
        for bounds in ([0,0,math.nan,1], [0,0,0,1], [0,-.1,1,1], [0,0,True,1]):
            bad = json.loads(json.dumps(original)); bad['patches'][0]['bounds'] = bounds
            with self.assertRaises(ValueError): validate_imagery_detail(bad)
        for changes in ({'version':True},{'zoom':True},{'patches':[]},{'source':''}):
            with self.assertRaises(ValueError): validate_imagery_detail(dict(original, **changes))
        Image.new('RGB',(1,1),'green').save(self.out/original['patches'][0]['file'])
        with self.assertRaisesRegex(ValueError, 'native resolution'): check(self.out)
        (self.out/original['patches'][0]['file']).write_bytes(b'bad jpeg')
        with self.assertRaises(Exception): check(self.out)

    def test_download_or_install_failure_preserves_existing_data(self):
        self.build(); before = self.snapshot()
        calls = 0
        def failing_mosaic(bounds, zoom, kind):
            nonlocal calls
            calls += 1
            if calls == 3: raise OSError('download failed')
            return native_mosaic(bounds, zoom, kind)
        with patch.object(builder, 'mosaic', failing_mosaic), patch.object(builder, 'terrain_data', return_value={'w':2,'h':2,'elevations':[500]*4}):
            with self.assertRaisesRegex(OSError, 'download failed'):
                builder.build(self.gpx, dict(self.config, detailImageryZoom=17), self.out)
        self.assertEqual(self.snapshot(), before)
        replace = Path.replace; failed = False
        def fail_once(path, target):
            nonlocal failed
            if not failed and path.parent.name == 'stage' and path.name == 'route.json':
                failed = True; raise OSError('install failed')
            return replace(path, target)
        with patch.object(Path, 'replace', fail_once), self.assertRaisesRegex(OSError, 'install failed'):
            self.build()
        self.assertTrue(failed); self.assertEqual(self.snapshot(), before); check(self.out)

    def test_mosaic_exact_block_downloads_only_sixteen_source_tiles(self):
        image = io.BytesIO(); Image.new('RGB',(256,256),'green').save(image,format='JPEG')
        with tempfile.TemporaryDirectory() as cache, patch.object(builder.tempfile, 'gettempdir', return_value=cache), patch.object(builder, 'download', return_value=image.getvalue()) as download:
            block = 4/2**17
            im, box = builder.mosaic([100*block,200*block,101*block,201*block],17,'sat')
            self.assertEqual(im.size,(1024,1024)); self.assertEqual(box,(0,0,1024,1024)); self.assertEqual(download.call_count,16)
            builder.mosaic([100*block,200*block,101*block,201*block],17,'sat')
            self.assertEqual(download.call_count,16)


if __name__ == '__main__': unittest.main()
