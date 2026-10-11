
### 阶段：列表适配器：卡片选择页是空白的；"卡片就是链接"的列表学不出 id；以及一次把作品半边删掉的安装（2026-10-04）

用户：**「继续列表适配器。首先，尝试手动使用 bat 下 bug 了：… which card?
http://127.0.0.1:59706/?token=… 打开的是一个只显示了 <那个地址> 的空网页」**

```text
一、选择页空白：页面拿到的是**标注页的文案表**
  `session_server.choose_card` 把 `l10n.chrome(lang)`（标注页的 chrome）当作文案发给卡片选择页，
  而选择页自己的词在 `l10n.CHOOSER` 里、从来没有调用者；模板第二行读 `T.count`（chrome 里没这个键）
  → `undefined.replace(...)` 抛错 → 脚本死在那里 → 页面只剩 header 里那一行 URL。
  实测（curl 打活的端口取它真正发出去的 HTML）：`<title>` 是"SiteProbe 标注"，payload.text 里有
  pictureFailed、没有 count。
  修：`l10n.chooser(lang)`（它自己的词 + 真正复用的三个 chrome 键），`__TITLE__` 也取自它 ✓
  守卫：新测试**读服务端真正发出去的那份 HTML**，把它的 `T.<key>` 与 payload 对照；退回旧行为跑一遍，
  红在 "the chooser page reads ['chosen','count','use'] and was not given them" ✓
  同一条不变量也加进了标注页的 HTTP 往返测试 —— 这一类（页面拿到缺键的文案表）两页一起盖。

二、「卡片就是链接」（bilinovel 的卡是 `<a class="book-layout">`）：标了 id，却学不出规则
  先量再改：`resolve` 一个**点名了行本身**的选择器——即使那一行就是这个元素——返回 **None**；
  而**去掉 select** 的规则读到的正是这一行（`_elements` 回落到 scope 根）。
  旧行为：`_inside_the_row` 丢弃点名行的规则 → draft 里 `missing: ["source_id"]` → **运行时从这一页读 0 张卡**
  （卡片没有 id 就被丢掉，bat 只说了句 "the runtime read no cards"）。
  修：点名行、且读的是**属性**时改写为「读这一行」（去掉 select）；读文本的照旧丢弃（整张卡的文本当标题
  比什么都不给更糟——老的 `test_a_rule_naming_the_row_is_dropped_not_shipped` 继续成立）。
  同一条链上另外两条测量出来的缺口，一并修在一个地方：
    · **量到的规则没被写出去**：`source_id` 在比较时被 `card_rule_for_id` 收成 `/novel/(\d+)`，
      落盘却是没收的那条 → 每篇作品的 id 会变成整条 URL（它要去命名导出目录与 media id）。
      收窄现在发生在选择它的地方（`_as_shipped`），量到的就是写出去的 ✓
    · **卡片不携带作品地址**：卡片只有被标注的字段，`detail_url` 缺失 → 复核页链接、selection 下载、
      导出的 `detail_url` 全空。Builder 现在从同一个链接派生 `detail_url`（去 filter/group、绝对化），
      与 id 指向同一个元素 ✓
    · **学来的列表根本爬不动**：`site_api` 向站点要 `list_work_urls`，而 declarative 只有 `list_cards`
      → `probe.py <列表 URL>` 答 "only supports a single work URL"（正是 bat 打印给用户的那条命令）。
      补上 declarative 的 `list_work_urls`（走同一份卡片），并让 `site_api` 把 target_url 交给钩子
      （learned listing 没有 URL 配方：人要的那一页就是 URL）✓
  真跑验收：`probe.py --limit 3 <列表页>` → listed 30 card(s) / 3 work URL(s) / read 3 work document(s) /
  cover 3；导出 `export/www.bilinovel.com/search_weekvisit_…/items/{2906,3095,3343}/metadata.json`，
  `detail_url` 与 id 都对 ✓

三、一次把作品半边删掉的安装（我造成的，已按记录重建）
  **`install()` 整份写 `site.json`**，而一个站点的适配器有**两半**（`work` / `listings`，各自的
  targets/documents），两次 build 又落在同一个目录 → 后一次把前一半整个删掉。
  实测：bilinovel 的 `local/www_bilinovel_com/` 目录 mtime 停在 **10-03 22:21**（那晚 work1..work3
  三样本的安装），而我今天 **16:35** 的列表 build 把三个文件换成了列表半边——作品的读法没了，导出还在。
  处置：用 10-03 那三个 session（4525 / 4057 / 4905）按工具自己的链路重建作品半边
  （load_session → learn → draft_site_json → compare），**round trip 4/4 通过**（与当初安装同一道门），
  再 install（现在会合并）→ 文件里两半共存；两半都探过：列表 30 张、作品 1 篇 ✓
  修：`install()` 按**节**合并（新一轮写的赢，没写的从文件里留：`work`/`listings`，以及 targets/documents
  各自的键）✓ 新测试 `test_installing_one_half_of_a_site_keeps_the_other_half`，退回旧行为时红在
  `KeyError: 'work'` ✓
  同一处还修到：`adapter.json` 的 capabilities 用 `getattr(dict, "fields", {})` 读——字典永远给默认值
  → **列表安装写出的 capabilities 一直是 `[]`**（实测：被覆盖前的那个 adapter.json 正是空的）。
  现在两半的字段都进去 ✓

四、量到但**没动**的（留给用户决定）
  同一篇作品在**两个入口**下身份不同：列表卡片的 id 是 `3095`（链接里的数字），而作品半边 target 的
  捕获组是 `3095.html` → 先从列表爬一遍、再按作品 URL 爬一遍，T³ 会看作两篇。这是**适配器自己的身份
  方案**（works 那边的 `3095.html` 是 10-03 就有的），改哪边是他的选择，我没有动。
```

```text
门（工具侧）：
  · `.venv/Scripts/python.exe -m pytest -q` → 360 passed
  · `tests/check_undefined_names.py` → 73 module(s)，0 undefined
  · `verify_doors.py` → 25/25 door(s) sound；0 static problem(s)
  · `verify_against_recordings.py` → PASS — 327 comparison(s), 0 mismatches
  · 三条新守卫都能失败（各自退回旧行为跑过一遍）：选择页文案表、行即链接的 id、两半合并
```
