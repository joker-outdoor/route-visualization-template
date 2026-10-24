# Route Visualization Template

可复用的单线 GPX / KML 路线页面：3D 地形、可选城市建筑、沿线飞行、底图、沿途地标、联动海拔曲线、手机布局和 2D 降级。源自 [龙泉七湖连穿](https://github.com/joker-outdoor/longquan-seven-lakes-2026-10-02)，也可作为 [贡嘎 100](https://github.com/joker-outdoor/gongga100-2026) 风格的起点。

仓库默认展示**合成路线、合成网格与合成地形**，不代表真实行程。模板代码、生成器与配置示例集中维护在这里，skill 只编排使用流程。

## 生成自己的页面

用 GitHub 的 Use this template 创建自己的仓库；修改在 feature 分支中完成。原始 GPX / KML 放仓库外或 `inputs/`（已忽略），配置参照 `examples/route.config.json`。生成器可直接读取 KML 的唯一 `gx:Track`，不会把独立 `Point` 起终点拼进路线。

```sh
python3 -m pip install -r requirements.txt
python3 scripts/build_data.py /path/to/original.gpx --config route.config.json --output data
python3 scripts/check_data.py
node --check app.js
node --test scripts/test_route_style.mjs
python3 -m http.server 8080 --bind 127.0.0.1
```

浏览器打开 `http://localhost:8080`；`?view=2d` 强制使用俯视图。直接打开文件不支持 ES modules / fetch。生成后的浏览器运行依赖全部在仓库内，无需地图 API key。

生成阶段需要网络，缓存置于系统临时目录 `joker-outdoor-tile-cache`。底图默认 Esri World Imagery zoom 14，DEM 为 Terrarium zoom 12；大路线可在配置中降低 `imageryZoom` / `demZoom`。每种底图最多 128 个瓦片，超限时明确报错。

城市近景可在自己的路线配置中增加 `"detailImageryZoom": 17`（只接受整数 15–18，布尔值非法）。默认示例不配置它，旧路线的输出和加载方式保持不变；`--demo` 不提供真实高清影像，需要省略此选项。全景仍使用最长边 1200px 的 `satellite.jpg`，高清来自同一 Esri 缓存中的原生瓦片，而非将全景插值放大。成都纬度 z17 约为 1.03 m/px；4×4 个 256px 瓦片组成 1024px 块，地图边缘按实际范围裁切。

生成器沿每段轨迹按不超过 250m 采样，覆盖约 600m 缓冲（选区多留半个采样间距），不会遗漏只有两个端点的长直线。下载前检查总计最多 256 块、4096 个源瓦片；超过限制需降低 `detailImageryZoom` 或缩短路线。新增 `data/imagery-detail/`、`imagery-detail.json`，成功后才在 `route.json` 写入 `imageryDetailFile`。manifest 为 `{version:1, zoom, source, patches:[{file,bounds}]}`；文件相对 `data/`，`bounds=[u0,v0,u1,v1]` 是地图 Mercator 归一化范围，图片北向上。全部下载、生成和校验完成后才替换输出，安装失败恢复旧数据；DEM、原轨迹点和统计口径保持原样。

浏览器只读本地文件，在 3D 近景按视线地表目标及前瞻方向加载；远景与 2D 使用全景底图。桌面和手机均限制最多 12 个局部纹理/mesh、4 个并发加载，约每 250ms 更新选区；1024px 纹理含 mipmap 的 GPU 预算约 64 MiB（另有底图、浏览器解码及网格开销），不拼成整幅大纹理。淘汰时释放纹理与材质，共享地形网格保留。纹理按钮同时控制局部块；无 manifest 不额外请求，坏 manifest、越界路径或局部加载失败都保留全景底图，不阻断飞行。`check_data.py` 会校验可选 manifest、路径、范围及可解码的图片尺寸。近景约指相机距目标不超过 2.5km、距目标地表高度不超过 1.5km。

## 配置与数据口径

- 必填 `title` 和 `madeOn`（页面日期）；`recordedOn` 是原轨迹日期，可置空，不能把页面日期或文件名当活动日期。
- 可选 `subtitle`、`routeLabel`、`startName`、`finishName`、`landmarkTitle`、`landmarkNote`。起点为绿圆点（`#22c55e`），终点为红圆点（`#ef4444`）；3D / 2D 都沿用真实轨迹端点，无文字标签、边框或引线。起终点名称用于悬停提示、无障碍名称与点击详情，两点屏幕距离不足 16px 时，仅将圆点沿连线方向小幅推开到 16px，轨迹坐标和点击对应点不变。
- `landmarks` 的每项必须有 `name`、`positionSource`，以及零起始的 `index` 或 WGS84 `lon` / `lat`。坐标吸附到最近轨迹点。只有名称和顺序时，先补定位依据；不要按里程比例伪造地标位置。概略定位必须写明。
- 可选 `kilometerMarkers: {"distanceKm": 42.195, "positionSource": "按官方全程42.195 km比例定位"}`，仅在自己的路线配置中启用，模板 demo 默认不启用。`distanceKm` 须为有限正数（拒绝布尔、字符串），整数公里牌最多 1000 个，`positionSource` 须为非空文字。生成器与数据检查共用校验；浏览器遇无效配置会停用公里模式并注明，地图仍可使用。
- 启用后，整数 `k` 从 1 到 `floor(distanceKm)`；几何位置为 `k × points[-1][3] / distanceKm`，在相邻原始轨迹点间插值并按 DEM 贴地。42.195 km 全程生成 1–42 共 42 个“km”牌，42 km 在终点前约 0.195 官方 km；不生成 43 km、不改轨迹点或统计。页面注明“公里标记按官方全程42.195 km与轨迹几何长度等比例定位”，依据仍来自所填 `positionSource`。标记不代表官方公里牌的实测坐标。
- 公里模式下，飞行读数、当前位置、地标里程和剖面标尺采用同一比例，总里程与终点显示 3 位小数。剖面曲线像素位置、GPX 与几何距离字段保持不变；未配置时仍显示原来的几何里程。3D 和 2D 均使用同一组公里牌定义，全景减少标签密度，飞行优先当前和前方相邻公里，重合往返段按行进里程挑选，手机避开控件与剖面；每牌根节点含 `data-km`、`data-geometry-km` 和可访问名称。
- 距离从 GPX 坐标测算；剖面保留 GPX 海拔，3D 路线贴合 DEM。地形默认夸张 3 倍，可以调回 1 倍。
- 原 GPX 的 `Distance`（米）、`ElevationGain` / `ElevationLoss`（米）、`BeginTime` / `EndTime`（Unix 毫秒）扩展可提供记录统计。优先读取包含此轨迹段的 `trk/extensions`；逐字段缺失时回退到 `gpx/extensions`。用时也可从完整且顺序正确的逐点 ISO 时间得到。其它格式未识别的统计显示未提供，不把海拔噪声累计为正式爬升。
- 要手工提供统计，配置 `stats` 的 `gainM`、`lossM`、`durationHours`、`sourceDistanceKm`，同时必须填写 `statsSource`。缺失值用 `null`。
- 可选 `routeColor` 为六位十六进制统一色；默认沿用模板颜色。网页提供统一 / 海拔 / 速度着色，3D 粗线、细线、遮挡线、2D 与剖面使用相同映射，速度由红色（最慢，`#ef4444`）经黄色（中间，`#facc15`）到绿色（最快，`#22c55e`），使用原有中间 90% 分位范围；少量或常量时取实际范围。海拔配色不变，图例注明单位与缺失 / 停留，缺失与停留仍使用独立颜色。旧数据无速度时禁用速度按钮。日期保留在数据中，默认不在 UI 展示。
- 两步路 `Document id="TbuluKmlVersion2"` 的 KML `PauseTime` 单位为毫秒：运动时间 = 总耗时减暂停。原记录里程优先用于平均配速；地图里程仍按坐标测算，分别注明口径。`SportAvgSpeed` 仅在与里程 / 运动时间一致时采用。其它导出方或 GPX 的 `PauseTime` 单位不猜测；核实后可配置有 `statsSource` 的 `stats.pauseSeconds`。缺少可靠暂停统计时只显示总耗时（未扣暂停），不伪造运动时间或平均配速。
- `points` 仍为六列；并行 `speedMps` / `speedState` 与点序对齐，单位为 `speedUnit="m/s"`，来源见 `speedSource`。速度按相邻坐标与时间差推算，不解码语义未知的 `GxTrackExtendedData`。首点、缺失时间和零时间差为 `null / missing`；超过 30 秒的间隔为 `null / gap`；低于 0.5 m/s 标为 `stopped`。速度表示结束于该点的区间；停留不显示配速。这些局部标记不替代原记录暂停汇总。
- 支持 GPX 1.0 / 1.1 的一个连续 `trkseg` 或 KML 2.2 的一个 `gx:Track`，2–20000 点，每点必须有海拔；多段轨迹先拆分。直线路线按长边地面长度扩大短边留白；超大、跨日期变更线、极区或留白后仍超出支持范围的路线明确拒绝。

公开 `data/route.json` 可含相对速度与活动汇总，不含逐点绝对时间或未知扩展数组。公开 `data/route.gpx` 只保留轨迹名、坐标和海拔，去掉作者、账号、头像、照片、逐点时间及原扩展。发布前核查生成数据与配置，不提交原始输入。

## 城市建筑与沿线飞行

地图上的「沿线飞行」需点击开始，直线路段按全程标称约 180 秒推进，可切换 1 / 2 / 4 倍模拟速度；不表示真实运动速度。急弯前瞻或朝向误差较大时温和减速至约半速，弯多路线会超过标称时长。镜头环绕航向与最终显示朝向按真实时间（不乘倍速）舒缓转动，目标上限 18°/秒，带加速与减速；退化方向保留上一航向，折返绕行而不横穿路线中心。构图试算用独立相机，不影响实际帧；暂停与恢复保持实际视线和控制器目标一致。首次进入、拖进度和终点重播允许直接定位，普通恢复不跳镜。普通路段相机在路线后方约 320 m（手机 400 m）、上方约 240 m，前瞻 200 m；遇前方或身旁高楼时，根据屋顶高度、面板外地图可见区域调整取景高度、后退距离和视角，兼顾塔顶与路线。按原始轨迹累计坐标距离插值，不用样条截弯；约 8px 的移动点、坐标里程与剖面同步。暂停保持进度与构图，并释放相机约束；拖动进度只定位一次，终点停止，再点播放从起点重播。操作地图、地标、剖面、全景、俯视或旋转会暂停，需显式恢复；全景和俯视恢复原投影。无建筑时飞行仍可用；2D 隐藏飞行。减少动态效果的系统设置不会阻止主动播放。

生成时可增加 `--buildings /path/to/buildings.json`。生成器先校验输入，复制为 `data/buildings.json` 并写入 `route.json` 的 `buildingsFile`；不传参数的旧调用不变。模板 demo 不附带真实建筑数据。既有数据可选 `buildingsFile` 指向 `data/` 内的 JSON，不能越出该目录；未指定时不请求建筑，加载失败也不阻断地形或飞行。

```json
{
  "version": 1,
  "source": {
    "name": "OpenStreetMap contributors",
    "url": "https://www.openstreetmap.org/copyright",
    "license": "ODbL-1.0",
    "extractedOn": "2026-10-24",
    "corridorMeters": 500
  },
  "heightNote": "OSM 标注高度；楼层按 3 m/层换算，缺省 12 m。",
  "buildings": [{
    "id": "way/example",
    "ring": [[104.0, 30.0], [104.001, 30.0], [104.001, 30.001], [104.0, 30.001]],
    "heightM": 42,
    "minHeightM": 12,
    "heightSource": "osm-levels",
    "part": true,
    "name": "示例部件"
  }]
}
```

`ring` 为至少三个不同 WGS84 点的非零面积轮廓，不重复末点；支持凹多边形。`heightM` 是楼顶相对地面的米数，`minHeightM` 是底部离地米数，须满足 `0 <= minHeightM < heightM <= 1000`，实际厚度是两者之差。`heightSource` 可取 `osm-height` / `osm-levels` / `osm-estimate` / `default-estimate`；估值应在准备数据时填入。`part` 是布尔值，可选 `name`、六位十六进制 `color`、`note`。建筑文件须保留来源、许可、提取日期、沿线范围与估高说明，页面在「轨迹与数据说明」中显示。

数据准备时去掉已被部件替代的 parent 包围轮廓；渲染器逐个保留部件和 `minHeightM`，不会把电视塔观景层下方填成整柱。一个合批 mesh 显示浅暖灰 / 蓝灰体块，无外墙纹理。地面取现有 DEM，建筑高度默认夸张 1.5 倍，可调 1–4 倍，与地形高度、GPX 海拔独立；调整地形后建筑仍贴地。建筑文件逐项无效时浏览器跳过该项；生成与数据校验则拒绝不合约的输入。MP4 导出仍沿用原有视频页面，本轮地图建筑与飞行不改视频导出。

## 验证和发布

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
node --test scripts/test_route_style.mjs
python3 scripts/build_data.py examples/demo.gpx --config examples/route.config.json --output data --demo
python3 scripts/check_data.py
```

`--demo` 只生成明确标注的合成地形与底图，用于离线开发和测试；真实行程生成时省略此参数。浏览器检查桌面、手机、地标点击、剖面联动与 `?view=2d`。GitHub Actions 验证数据和脚本；合入后启用 GitHub Pages：main 分支，根目录 `/`。发布后再次检查在线页面。

现有测试入口同时加载 `test_city_flight.mjs`，使用实际 Three.js 几何和 CPU 场景替身检查凹轮廓法线、悬空部件、独立高度、相机移动、暂停、进度、倍速、重播、开关与加载失败。它不验证 WebGL 画面、手机布局或视觉效果；发布前另在真实 Edge 验看城市近景、电视塔部件与窄屏控件。

同一入口还运行 `test_detail_imagery.mjs`，检查分块请求/驻留上限、节流、裁切平面、南北 UV、淘汰、迟到、开关和失败回退。Python 回归以模拟影像检查长直线选区、边缘原生裁切、下载/替换失败保护及 manifest 校验；这些离线 fixture 不代表真实 Esri 影像的视觉验收。城市项目同步后仍需在真实 Edge 核对金沙、电视塔、环球中心近景，以及拖动、飞行和手机效果。

## 来源

- Three.js 0.160.0 官方原文件，MIT，见 `vendor/LICENSE`。模板保留文件原文。
- 真实底图由 [Esri World Imagery](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer) 生成。版权归相应影像提供者，不随模板代码再许可。
- DEM 来源 [Tilezen / Mapzen Terrain Tiles](https://github.com/tilezen/joerd)，保留 [对应数据署名与许可](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)。生成其它地区路线时核对当地数据源的署名要求。

## 导出 3D 飞越视频

`video.html` 使用同一份 `data/`，按 GPX 距离推进镜头、移动点和海拔剖面；前后保留全景。数据可使用模板的 `landmarks`，兼容旧七湖页面的 `lakes`。视频显示轨迹日期、制作日期、数据署名和定位说明，不把动画时长当实际行走速度。演示数据仍明确标为合成。

本机安装 Microsoft Edge、ffmpeg（含 ffprobe）与 Node.js；`npm ci` 安装锁定的 Playwright。渲染器启动独立 headless Edge 和仅监听 127.0.0.1 的短时服务器，结束后关闭，不使用个人浏览器登录态。逐帧指定动画时间，不依赖屏幕录制的实时帧率。

```sh
npm ci
node scripts/render_video.mjs --output /path/to/route-portrait.mp4 --poster /path/to/route-poster.png
node scripts/render_video.mjs --output /path/to/route-landscape.mp4 --width 1920 --height 1080
```

默认 1080×1920、30 fps、46 秒、无音轨，输出 H.264 / yuv420p / faststart MP4。`--width` / `--height` / `--fps` / `--duration` 可调整；已有文件拒绝覆盖。若复用外部已安装的依赖，可传 `--playwright /absolute/path/to/playwright/index.mjs`。

先用 `--duration 2` 做短片试验，再输出正式片；检查开场、中段、结尾的轨迹方向、地标、里程、海拔、字幕遮挡和黑屏。脚本验证起终点及 ffprobe 编码、分辨率、帧数、时长；视觉验收另做。MP4 可放 `videos/` 后在 README 或页面添加播放、下载链接，保留具体项目生成器版本。

### 运动健康统计

有已匹配的运动健康记录时，优先配置 `statsSource`、`stats.sourceDistanceKm`、`gainM`、`lossM`、`durationHours` 和 `pauseSeconds`。主里程展示有来源的配置运动距离，几何距离仍用于剖面定位。`durationHours` 为该活动起止跨度，`pauseSeconds` 为起止跨度减去 HealthKit 活动时长，因此不会再次扣除已排除的暂停；缺失统计显式置为 `null`。配置运动统计时不使用旧轨迹的 `SportAvgSpeed`。`trackSource` 标注坐标来源（例如运动健康 GPS），逐点速度仍由该轨迹坐标和时间差推算。不要用 GPS 海拔噪声累加替代 workout 的爬升汇总。

默认 3D 全景与俯视均北向上；手动旋转后点击全景恢复北向上，3D 全景保留地形倾斜。
