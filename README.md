# Route Visualization Template

可复用的单线 GPX 路线页面：3D 地形、底图、沿途地标、联动海拔曲线、手机布局和 2D 降级。源自 [龙泉七湖连穿](https://github.com/joker-outdoor/longquan-seven-lakes-2026-10-02)，也可作为 [贡嘎 100](https://github.com/joker-outdoor/gongga100-2026) 风格的起点。

仓库默认展示**合成路线、合成网格与合成地形**，不代表真实行程。模板代码、生成器与配置示例集中维护在这里，skill 只编排使用流程。

## 生成自己的页面

用 GitHub 的 Use this template 创建自己的仓库；修改在 feature 分支中完成。原始 GPX 放仓库外或 `inputs/`（已忽略），配置参照 `examples/route.config.json`。

```sh
python3 -m pip install -r requirements.txt
python3 scripts/build_data.py /path/to/original.gpx --config route.config.json --output data
python3 scripts/check_data.py
node --check app.js
python3 -m http.server 8080 --bind 127.0.0.1
```

浏览器打开 `http://localhost:8080`；`?view=2d` 强制使用俯视图。直接打开文件不支持 ES modules / fetch。生成后的浏览器运行依赖全部在仓库内，无需地图 API key。

生成阶段需要网络，缓存置于系统临时目录 `joker-outdoor-tile-cache`。底图默认 Esri World Imagery zoom 14，DEM 为 Terrarium zoom 12；大路线可在配置中降低 `imageryZoom` / `demZoom`。每种底图最多 128 个瓦片，超限时明确报错。

## 配置与数据口径

- 必填 `title` 和 `madeOn`（页面日期）；`recordedOn` 是原轨迹日期，可置空，不能把页面日期或文件名当活动日期。
- 可选 `subtitle`、`routeLabel`、`startName`、`finishName`、`landmarkTitle`、`landmarkNote`。
- `landmarks` 的每项必须有 `name`、`positionSource`，以及零起始的 `index` 或 WGS84 `lon` / `lat`。坐标吸附到最近轨迹点。只有名称和顺序时，先补定位依据；不要按里程比例伪造地标位置。概略定位必须写明。
- 距离从 GPX 坐标测算；剖面保留 GPX 海拔，3D 路线贴合 DEM。地形默认夸张 3 倍，可以调回 1 倍。
- 原 GPX 的 `Distance`（米）、`ElevationGain` / `ElevationLoss`（米）、`BeginTime` / `EndTime`（Unix 毫秒）扩展可提供记录统计。用时也可从完整且顺序正确的逐点 ISO 时间得到。其它格式未识别的统计显示未提供，不把海拔噪声累计为正式爬升。
- 要手工提供统计，配置 `stats` 的 `gainM`、`lossM`、`durationHours`、`sourceDistanceKm`，同时必须填写 `statsSource`。缺失值用 `null`。
- 目前支持 GPX 1.0 / 1.1 的一个连续 `trkseg`，2–20000 点，每点必须有海拔；多段轨迹需先拆分，避免把断点画成路段。超大、跨日期变更线、极区或极窄路线会明确拒绝。多条路线选择器可在此基础上另行实现。

公开 `data/route.gpx` 只保留轨迹名、坐标和海拔，去掉作者、账号、头像、照片、逐点时间及原扩展。发布前核查生成数据与配置，不提交原始输入。

## 验证和发布

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/build_data.py examples/demo.gpx --config examples/route.config.json --output data --demo
python3 scripts/check_data.py
```

`--demo` 只生成明确标注的合成地形与底图，用于离线开发和测试；真实行程生成时省略此参数。浏览器检查桌面、手机、地标点击、剖面联动与 `?view=2d`。GitHub Actions 验证数据和脚本；合入后启用 GitHub Pages：main 分支，根目录 `/`。发布后再次检查在线页面。

## 来源

- Three.js 0.160.0 官方原文件，MIT，见 `vendor/LICENSE`。模板保留文件原文。
- 真实底图由 [Esri World Imagery](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer) 生成。版权归相应影像提供者，不随模板代码再许可。
- DEM 来源 [Tilezen / Mapzen Terrain Tiles](https://github.com/tilezen/joerd)，保留 [对应数据署名与许可](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)。生成其它地区路线时核对当地数据源的署名要求。
