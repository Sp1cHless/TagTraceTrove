
### 阶段：列表适配器第二阶段（UI.md 222–259）：T³ 里的列表生成器，从入口一路走到 10 条预览（2026-10-04）

用户：**「下个阶段，也就是列表适配器的计划写好了。阅读，有问题问我，没有就开工」**（三个问题当场问过，答复：
① 适配器网页的说明换成列表那 4 条；② 预览落在导入页的 review；③ 第二个网址**必须填**）

```text
一、工具侧（适配器网页自己的文案）
  · 卡片标注页的说明：`l10n.LISTING_TIPS`（4 条，zh/en），由 `annotate.page(vocabulary="listing")` 选；
    `Session` 新增 `vocabulary`，`build_listing.py` 传 "listing" ✓
  · 「保存标注」下的收尾：卡片就是这次标注的全部，所以 `last=True`，页面显示
    `LISTING_CHROME["savedLast"]`＝「保存完成，适配器已经存储完毕，请回到 T³ 界面继续。」，
    不再出现「正在打开下一个网页…」✓
  守卫：`test_the_card_page_teaches_the_listing_job_and_says_when_it_is_done`（读服务端真正发出去的那份
  HTML：tips == 列表 4 条、savedLast 是列表的、saveNote/savedLast 里没有「下一个」；作品页仍是 3 条）。
  退回旧行为跑一遍，红在「work 的 3 条 ≠ 列表的 4 条」✓

二、T³ 侧：一次列表构建的请求与命令
  · `siteprobeRunRequestSchema` 的 build 变体新增 `kind`，并 refine「有 kind 就必须正好两个网址」；
    有 kind ＝ 列表构建（作品构建原样不变）✓
  · `transport.startSiteprobeBuild(..., kind?)`：有 kind 时走 `tooling.listingArgs`（默认
    `build_listing.py`）+ `--kind=<kind>`——就是工具自己 bat 的那条命令；`SiteprobeTooling` 因此多了
    `listingArgs`（与 `buildArgs`/`linkArgs` 同形，测试可覆盖）✓
  · 守卫：单测「builds a listing through the tool's listing door」（stub 只把 `--kind=` 打出来，
    作品构建没有这个参数，所以出现它就是走了列表门）；HTTP 集成测试「一个网址/三个网址 → 400，
    两个网址 → 201 且 kind 到达」✓

三、T³ 侧：面板（RuleBuilderPanel.vue）
  · 状态2：新增标题「单作品生成器」，重新开始按钮与它同一行（其余状态仍在右上角那一行）；
    下方是列表适配器区块（标题/说明/「准备好了，开始列表适配器」）✓
  · 作品状态3：「该网站已经存在适配器」提示右边新增「添加列表适配器」✓
  · 列表状态3：5 个类型按钮（search/artist/favorites/album/playlist）→ 选完才出现两个网址框
    （第一个框下方做作品适配器检测：没有就提示 + 按钮跳到作品状态3，并带上这个网址）→
    两个都填才能提交 → 状态注释与作品流程同一套（准备中/网页已打开/日志折叠/失败判定）→
    列表自己的 4 条说明 → 装好后「接下来会下载该网址下的前 10 个作品」+ 预览按钮 + 「可以不录入」✓
  · 预览：`startSiteprobeRun({input: 列表第一页, kind, limit: 10})` → 同一个
    `previewSiteProbeExportPath` → 交给导入页的 review（与作品预览同一个门，抽成了 `runAndPreview`）✓
  · i18n：新增 24 个 key（zh/en 同序）✓

四、真机走查（英文界面，bilinovel 列表，全程走 T³）
  状态2 → 「准备好了，开始列表适配器」→ 选 Search → 填两个 weekvisit 网址（未出现"没有作品适配器"提示，
  因为该站已有）→ 点击打开 → 日志出现 `reading with the browser / reading <page1>`（列表门的行）→
  卡片选择页（英文，因为 T³ 传了 SITEPROBE_LANG=en）→ 选第 1 张 → 卡片标注页显示**列表那 4 条说明**，
  保存后显示 **"Saved — the adapter is stored. Go back to T³ to continue."** → 面板进入 ready，
  日志末尾 `=== installed` + `the runtime reads 30 card(s)` → 点预览 →
  `10 work URL(s) to read` → 导入页 review 显示 **「10 Entries ready for review / 0 without a Cover」**，
  Type/Gallery 下拉、Canonical Tags Facet、字段映射行都在（多条预览与单条同一套）✓
  走查当场抓到两个文案 bug（都已修 + 加了守卫）：预览按钮上出现了未替换的 `{count}`（模板没传参），
  以及 ready 里"适配器已存储"重复了一遍；新守卫断言面板任何可见文本都不含 `{`。
  走查后 `local/www_bilinovel_com/site.json` 仍是两半（work + listings）——列表安装没有碰作品半边 ✓

门：工具 pytest 362 / undefined-names 73·0 / doors 25·25 / recordings 327·0；T³：server typecheck ✓、
server 单元+import 96、siteprobe HTTP 集成 21、web typecheck ✓、rule-builder-panel 13、i18n 与
gallery-app/add-entry-quick 226 全过、lint 0。
**并行的红不属于本轮**：`pnpm exec vitest run apps/web/tests` 有 18 条失败，全在 offline/pending-entry 那批
（`native-ordinary-mutations` 的 mtime 17:44:04、`offline-api` 17:38:16——都在我跑测试的当时被另一个进程
改写），与本次改动的文件无交集。
```
