# SiteProbe — 三个网站 probe 的合并版

一个通用提取引擎 + 每站自己的爬取方式。**加一个网站 = 加一个文件夹**，不改任何共享代码。

```text
siteprobe/                     # 本目录 = 工具本体（可独立使用，不接 T³ 也完整）
├─ 提取单条链接.bat           # 单条作品：粘贴网址，自动判断是哪个站
├─ 提取作者或收藏夹.bat        # 作者 / 收藏夹：先选站（菜单由注册表生成），再粘贴网址
├─ 通用单条链接.bat            # Level 0：任意站点，只读标题 + 封面，不需要规则
├─ 生成适配器.bat / 生成列表适配器.bat   # 交互造适配器（开浏览器标一个作品／一页列表）
├─ 修复预览图.bat / 修复缺失封面预览.bat  # 补图与还原
├─ 应用Tag审核.bat / 下载selection.bat
├─ 验收.bat                    # 把上面每一道门都开一遍，逐门报告（见「验收」）
├─ probe.py  pick.py  tag_review.py      # 入口
├─ show_link.py  run_site_step.py  build_adapter.py  build_listing.py
├─ verify_against_recordings.py          # 用真实录制页面离线验收
├─ verify_doors.py                       # 验收.bat 的实体：静态审计 + 真跑每道门
├─ src/generic/              # 通用层：不认识任何具体网站
└─ src/builder/              # Builder：造适配器用的（运行时从不 import 它）
```

**适配器不在本目录里** ✓。一个站点就是一份数据，放在 SiteProbe home
（`<T³ user data>/siteprobe/`，本机即 `D:\Project\TagTraceTrove\apps\server\.data\siteprobe\`
—— 和 `library.db` 同一个根，见指导 §34）：

```text
apps/server/.data/siteprobe/     # = <T3_DATA_DIR>/siteprobe
├─ installed/   # 单独取得的适配器（含本机手写的三个：comic18 / hitomi_la / hanime1_me）
├─ local/       # Builder 学出来的规则集（个人的，不进仓库）
├─ development/ # 开发中的，优先级最高
├─ sessions/    # Builder 的一次运行（页面、标注、草稿）
├─ cache/       # 站点侧的缓存
├─ export/      # 产出与字典，按网站分开
├─ sources/     # 适配器来源索引
└─ browser_profiles/  # 每站一个 Chrome profile（含 cookie，绝不进仓库）
```

`builtin/` **不在这里** ✓ —— 随包发布的适配器是只读代码 ✓，放仓库 `siteprobe/adapters/builtin/`
✓（指导 §34）✓。`development/` 只在有人开发适配器时存在 ✓。

home 的解析顺序（`registry.adapter_root()`）：`SITEPROBE_HOME`（T³ 拉起工具时显式传 ✓）→
仓库根的 `siteprobe.json`（双击 bat 时用它 ✓，所以两条路落在同一个 home ✓）→
`<T3_DATA_DIR>/siteprobe`（`T3_DATA_DIR` 缺省即 `apps/server/.data` ✓）。

优先级按架构文档 §17：`development > local > installed > builtin`。同一个域名有两份适配器
时两份都留着，各自服务自己声明的目标 —— `probe.py --list-sites` 会把两边**各自读什么**都打出来。

## 分工

用户要的“获取网页信息”与“爬取网页信息并保存”拆开之后是这样：

| 环节 | 在哪 | 通用吗 |
|---|---|---|
| 登录、翻页、反爬、拿原始页面 | 适配器的 `fetch.py` | 否，每站自己写 |
| 原始页面 → 标准字段 | 适配器的 `site.json` + `src/generic/` | 是，一份引擎 |
| 造适配器（标注 / 学习 / 回放 / 安装） | `src/builder/` | 是，不认站 |
| 写库、去重、更新游标 | `src/generic/` + T³ 的 `import:commit` | 是 |

`fetch.py` 只做一件事：下载并把文档**起名字**交给通用层（契约见 `src/generic/bundle.py`）。
它不构造记录、不写导出、不决定任何字段名。字段语义全部在 `site.json` 里，所以
“18comic 没有作品类型”不再是一段硬编码，而只是**没有那个 key**。

适配器是**按目录加载**的（`registry.load_fetcher` / `registry.site_module`），不是 `import
tool.<站>` —— 所以它放在 home 里也照样能跑，路径不用手写。

## 产出

按网站分开，每站内部结构与原来各自独立的 probe 一致。全部落在 SiteProbe home 的
`export/` 下（`<T³ user data>/siteprobe/export/`，本机即 `apps/server/.data/siteprobe/export/`）：

```text
<home>/export/<网站>/<清单名>/metadata.json
<home>/export/<网站>/<清单名>/items/<source_id>/metadata.json
<home>/export/<网站>/<清单名>/items/<source_id>/{raw/,cover/,previews/}
<home>/export/<网站>/taxonomy_dictionary.json      # 字典（已从三个旧工具迁入）
<home>/export/<网站>/tag_review.csv                # 待审核 Tag
```

清单名沿用各站原有约定：hitomi `artist_<slug>`、hanime `playlist_<id>`、
18comic `favorites_<user>_folder_<id>` 与 `single/<id>`。

`metadata.json` 的形态由各站 `site.json` 的 `manifest` 声明，因为 T³ 的导入端认两种
不同形态（id 列表 / 内嵌完整记录），且按内容区分。每个 manifest 都带 `origin`，
这正是 migration 021 的更新游标所读的字段 —— 三个旧工具都不写它。

## 单本作品的落盘位置

`single` / `sole_work` 是**同一个累积目录**：单个作品按 `items/<id>/` 落在里面，
manifest 会合并而不是覆盖，和旧 hitomi 工具的 `sole_work` 一致。

```text
export/18comic_vip/single/metadata.json                 # 累积的清单，含 origin
export/18comic_vip/single/items/1472965/metadata.json
export/18comic_vip/single/items/1472965/{cover,previews,raw.html}
```

`manifest.accumulate: true` 打开这个行为，`_accumulate()` 按 `source_id` 合并。
合并时会顺手丢掉**无法导入的记录**（缺 title 等），所以一次坏抓取不会让整个目录
永久不可导入 —— 这类记录现在会在运行时被跳过并报警，而不是写进去。

## 预览图还原

`installed/comic18/image_scramble.py` 与 `installed/comic18/repair_scramble.py` 是从旧工具
**逐字节复制**过来的（`image_scramble.py` 与原件完全一致），不是重写的。原因很实际：
条带顺序是一个精确的逆运算，手写变体会静默产出错页 —— 我第一版就是错的。

- 下载时还原：适配器 `fetch.py` 的 `download_media` 钩子在每张预览图落盘后调用
  `descramble_file`，所以导出从第一次就是正确的（运行时报告 `restored` 数量）。
- 离线补修：`修复预览图.bat`，默认只预览，`--apply` 会先把原图备份到 `_scramble_backup/`。
  它内部走 `run_site_step.py <站点key> <步骤>` —— 站点自己的步骤用**目录**加载，不再是
  `python -m tool.comic18.repair_scramble`（那个路径在目录布局改动后就不存在了）。
  带 XMP 标记的文件会被跳过。
- 封面不还原（`media/albums/` 站点不打乱）。

## 字典与 Tag 审核

三站各自的 `taxonomy_dictionary.json`（series / authors / characters / types /
tags.accepted / tags.rejected）与 `tag_review.csv`（`tag,decision,zh_cn`，UTF-8 BOM）
已原样迁入 `export/<网站>/`。繁体转简体用 OpenCC `t2s`，离线、确定性。已手填的
译文不会被覆盖。

一处**刻意统一**：旧工具对 `分类信息.分类标签` 是否按字典过滤并不一致（hitomi 和
18comic 会过滤，hanime 不过滤）。现在统一为 **原始 tag 减去 `tags.rejected`**，
理由有两条：hitomi 自家导出就是这么做的（在 620 条真实记录上逐一核对通过）；且新库
字典为空时若只保留 accepted，第一次导入会一个 tag 都进不去。

## 验收

**先跑这道，它回答“工具现在到底能不能用”。** 双击 `验收.bat`（或
`.venv/Scripts/python.exe verify_doors.py [--slow]`）：它把每一个 bat 调用的脚本/模块先
静态审计一遍（引用了不存在的路径直接 FAIL），再**用 bat 用的那个解释器**把 12 道命令行门
真跑一遍（失败得快的输入），最后把 8 个 bat 以“双击、什么都不填”的方式开一遍，逐门报告。

它抓的是单元测试碰不到的东西 —— 提交历史里每一个“用户随手打开就出错”都是这一类：
`uv sync` 构建不了、bat 调了已删除的模块路径、入口函数里读了没传进来的变量、`--list-sites`
打印完没 return。两个会写盘的 bat（`应用Tag审核`）和它自己（`验收.bat`）不在这轮里，
所以这个验收随时可跑、不改任何数据。

```text
.venv/Scripts/python.exe -m pytest -q                    # 全套单元测试
.venv/Scripts/python.exe verify_against_recordings.py    # 真实录制页面（离线）
.venv/Scripts/python.exe verify_doors.py --slow          # 含两个会开浏览器的造适配器门
```

`verify_against_recordings.py` 直接用三个站已经存在硬盘上的**真实原始文档**跑通用
路径，再和旧工具产出的 golden 文件逐字段对比：

| 站点 | 原始文档 | 对比对象 | 规模 |
|---|---|---|---|
| hitomi | `cache/galleryinfo/*.js` | `works.json` | 3901 部作品 |
| hanime1 | `raw/playlist*.html` + `items/*/raw.html` | `items/*/metadata.json` | 471 部作品 |
| 18comic | `output/*/items/*/raw.html` | `items/*/metadata.json` | 21 部作品 |

当前结果：**327 项比较，0 处不一致**。三类已知差异是刻意保留的，并且在脚本里被
断言而不是跳过：

1. `date_added` 统一成 `YYYY-MM-DD`（旧 hitomi 存的是 `2017-02-12 19:01:00-06`，
   T³ 导入本来也只取前 10 位，而更新游标需要日期形）。
2. `分类标签` 按字典过滤，所以与字典更新前的 golden 之间只允许差 `tags.rejected`
   里的 tag。
3. 标题内部多余空格被压成单个空格。

导出物还要能过 T³ 的导入器，这是最终门禁：

```text
cd D:\Project\TagTraceTrove
pnpm import:site-probe <export>/<网站>/<清单>/metadata.json --output canonical.json
```

三个网站的导出都已通过，并且 `origin` 被正确转成 batch 字段。

## 加一个新网站

1. 在适配器来源里新建一个目录（`installed/<站>/`，或让 Builder 生成到 `local/<站>/`）；
2. 写 `site.json`：hosts、targets（网址正则）、`listing`（列表页怎么读）、
   `work.fields`（每个标准字段从哪来）、`manifest`（清单形态）、`naming`（文件夹名）；
3. 写 `fetch.py`：`build_bundle(template, raw_input, options) -> RawBundle`；
4. 抓几个真实页面存成 fixture，用 `--offline` 跑通再联网。

`site.json` 的可用选择器见 `src/generic/select.py` 顶部注释。整站不用手写也行：跑
`生成适配器.bat` 粘贴两三个作品网址，标注一次、确认其余，它会把规则学出来并安装。

## 运行环境

```text
uv sync --extra browser --extra media        # bat 首次运行会自动执行这一条
uv sync --extra browser --extra media --extra dev   # 想跑 pytest 时加 dev
```

通用层与 hitomi / hanime 只用标准库；18comic 需要 Playwright（用户手动登录）、httpx
（图片）与 Pillow（还原被打乱的预览图）。

## 已知边界

- **18comic 单本录入是全自动的，不打开浏览器、不需要确认。** 这点我一开始判断错了：
  裸 `urllib` 和 `httpx` 会拿到 `HTTP 403` / `Cf-Mitigated: challenge`，但原因不是
  cookie 无效，而是 **`cf_clearance` 与浏览器的 TLS 指纹绑定**。改用 `curl_cffi`
  复刻 Chrome 握手后，同一份 cookie 直接返回 `HTTP 200` 且所有选择器都在。实测结果：

  ```text
  urllib      → 403  Cf-Mitigated: challenge
  curl_cffi impersonate=chrome / chrome120 → 200, 页面完整
  curl_cffi impersonate=chrome136 / chrome124 → 403（所以 IMPERSONATE 是可调且值得复测的）
  ```

  抓取阶梯（由便宜到贵，只在真的需要时才打扰你）：

  1. 缓存 / `--offline` 录制的页面 —— 重复运行走这里，完全静默；
  2. **`curl_cffi` 无浏览器请求**（带已保存的 cookie）—— 单本常规路径，实测全自动；
  3. 附着到**已经开着**的调试 Chrome（`--remote-debugging-port=9222`）—— 不新开窗口、
     不问你任何事。工具的 Chrome 用完**故意不关闭**；
  4. 都没有才启动 Chrome 并提示你完成校验后回车。非交互运行（stdin 不是终端）时不会
     新开一个没人管的窗口，而是明确报错让你用 .bat 跑。

  每一步成功后 cookie 都会写回 `session/importer-cookies.json`（旧工具的
  `storage_state.json` 也会被读取作为起点）。
- **收藏夹仍然需要登录一次**：收藏夹是账号内的数据，未登录时页面照样返回 200 但没有任何
  收藏夹结构。此时工具会明确告诉你“请在工具打开的 Chrome 里登录一次”，登录后的 cookie
  会被保存，之后收藏夹也走第 2 步自动完成。
- 新工具默认使用旧 18comic 工具的 Chrome Profile（适配器 `site.json` 的
  `session.profile_dir`），既有的登录状态直接沿用。
- 诊断脚本：`test_tls_impersonation.py`（复测哪个 `impersonate` 还能过校验，Cloudflare
  改版后先跑它）、`test_favorite_parse.py`（收藏夹页面结构/登录状态诊断）。两者都按站点
  key 从注册表取适配器，所以不存在旧路径。
- **hitomi 封面地址依赖 `gg.js`**：那是站点内部的 CDN 分片子域算法，无法用声明式规则
  表达，因此由该适配器的 `fetch.py` 计算后作为 card 字段交给模板。离线验收因此
  不覆盖封面地址，改由单元测试用合成 `gg.js` 覆盖。
- **JS 渲染的站点**需要无头浏览器，不在当前通用层能力范围内。
- 旧的三个工具目录未删除，仍可独立使用；新工具只读它们的 `exports/` 作为原始文档来源
  与验收依据。
