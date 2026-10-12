# Route Visualization Template

可复用的单线 GPX / KML 路线页面：3D 地形、底图、沿途地标、联动海拔曲线、手机布局和 2D 降级。源自 [龙泉七湖连穿](https://github.com/joker-outdoor/longquan-seven-lakes-2026-10-02)，也可作为 [贡嘎 100](https://github.com/joker-outdoor/gongga100-2026) 风格的起点。

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

## 配置与数据口径

- 必填 `title` 和 `madeOn`（页面日期）；`recordedOn` 是原轨迹日期，可置空，不能把页面日期或文件名当活动日期。
- 可选 `subtitle`、`routeLabel`、`startName`、`finishName`、`landmarkTitle`、`landmarkNote`。起点为绿圆点（`#22c55e`），终点为红圆点（`#ef4444`）；3D / 2D 都沿用真实轨迹端点，无文字标签、边框或引线。起终点名称用于悬停提示、无障碍名称与点击详情，两点屏幕距离不足 16px 时，仅将圆点沿连线方向小幅推开到 16px，轨迹坐标和点击对应点不变。
- `landmarks` 的每项必须有 `name`、`positionSource`，以及零起始的 `index` 或 WGS84 `lon` / `lat`。坐标吸附到最近轨迹点。只有名称和顺序时，先补定位依据；不要按里程比例伪造地标位置。概略定位必须写明。
- 距离从 GPX 坐标测算；剖面保留 GPX 海拔，3D 路线贴合 DEM。地形默认夸张 3 倍，可以调回 1 倍。
- 原 GPX 的 `Distance`（米）、`ElevationGain` / `ElevationLoss`（米）、`BeginTime` / `EndTime`（Unix 毫秒）扩展可提供记录统计。优先读取包含此轨迹段的 `trk/extensions`；逐字段缺失时回退到 `gpx/extensions`。用时也可从完整且顺序正确的逐点 ISO 时间得到。其它格式未识别的统计显示未提供，不把海拔噪声累计为正式爬升。
- 要手工提供统计，配置 `stats` 的 `gainM`、`lossM`、`durationHours`、`sourceDistanceKm`，同时必须填写 `statsSource`。缺失值用 `null`。
- 可选 `routeColor` 为六位十六进制统一色；默认沿用模板颜色。网页提供统一 / 海拔 / 速度着色，3D 粗线、细线、遮挡线、2D 与剖面使用相同映射，速度由红色（最慢，`#ef4444`）经黄色（中间，`#facc15`）到绿色（最快，`#22c55e`），使用原有中间 90% 分位范围；少量或常量时取实际范围。海拔配色不变，图例注明单位与缺失 / 停留，缺失与停留仍使用独立颜色。旧数据无速度时禁用速度按钮。日期保留在数据中，默认不在 UI 展示。
- 两步路 `Document id="TbuluKmlVersion2"` 的 KML `PauseTime` 单位为毫秒：运动时间 = 总耗时减暂停。原记录里程优先用于平均配速；地图里程仍按坐标测算，分别注明口径。`SportAvgSpeed` 仅在与里程 / 运动时间一致时采用。其它导出方或 GPX 的 `PauseTime` 单位不猜测；核实后可配置有 `statsSource` 的 `stats.pauseSeconds`。缺少可靠暂停统计时只显示总耗时（未扣暂停），不伪造运动时间或平均配速。
- `points` 仍为六列；并行 `speedMps` / `speedState` 与点序对齐，单位为 `speedUnit="m/s"`，来源见 `speedSource`。速度按相邻坐标与时间差推算，不解码语义未知的 `GxTrackExtendedData`。首点、缺失时间和零时间差为 `null / missing`；超过 30 秒的间隔为 `null / gap`；低于 0.5 m/s 标为 `stopped`。速度表示结束于该点的区间；停留不显示配速。这些局部标记不替代原记录暂停汇总。
- 支持 GPX 1.0 / 1.1 的一个连续 `trkseg` 或 KML 2.2 的一个 `gx:Track`，2–20000 点，每点必须有海拔；多段轨迹先拆分。直线路线按长边地面长度扩大短边留白；超大、跨日期变更线、极区或留白后仍超出支持范围的路线明确拒绝。

公开 `data/route.json` 可含相对速度与活动汇总，不含逐点绝对时间或未知扩展数组。公开 `data/route.gpx` 只保留轨迹名、坐标和海拔，去掉作者、账号、头像、照片、逐点时间及原扩展。发布前核查生成数据与配置，不提交原始输入。

## 验证和发布

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
node --test scripts/test_route_style.mjs
python3 scripts/build_data.py examples/demo.gpx --config examples/route.config.json --output data --demo
python3 scripts/check_data.py
```

`--demo` 只生成明确标注的合成地形与底图，用于离线开发和测试；真实行程生成时省略此参数。浏览器检查桌面、手机、地标点击、剖面联动与 `?view=2d`。GitHub Actions 验证数据和脚本；合入后启用 GitHub Pages：main 分支，根目录 `/`。发布后再次检查在线页面。

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
