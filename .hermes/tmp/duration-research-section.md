
### 结论/其它：视频"时长"能不能作为可提取信息（与 page 同级）—— 五个视频站实测（2026-10-08）

用户的问题：时长可否进 entry 信息、**与 page 同级**；不做自动检测（不限制 entry 内容，所以没有"是不是视频"的判据）；
唯一能察觉它的时机就是**建 import rule 点选信息**的时候。预期是动漫/电影详情页会写时长、没有就算了；
更常见的是视频播放页，时长"在播放器里看得见"，但通用规则能不能抓到不确定 —— 要研究。
给的五个地址都在播放页里，播放器上都显示时长。

**实测（served HTML，curl，Chrome 131 UA；"读到"是用现有引擎真跑出来的值）**

| 站点 | 详情页有没有本片时长 | 形态 | 现有通用规则 |
|---|---|---|---|
| hanime1.me | **有** | `<meta property="og:video:duration" content="805">`（秒） | **能读，零改动** |
| missav.ws | **有** | 同上，`content="5881"` | **能读，零改动** |
| jable.tv | 没有 | 只有**相关推荐卡片**的 `<span class="label">2:02:43</span>` | 读不到 |
| yhdm7.net | 没有 | 播放器配置 `player_aaaa` 里只有 m3u8 地址 | 读不到 |
| nnyy.in | 没有 | 播放地址在 XHR（`/_gp/<id>/<ep>`）里，9 个镜像 | 读不到 |

**"能读"是用引擎跑的，不是看 HTML 猜的**（`src/generic/select.py` 的 `meta` 选择器 + `int` transform）：

```text
  hanime1  {"from":"meta","property":"og:video:duration","transform":["int"]}  -> 805
  missav   ...                                                               -> 5881
  jable / yhdm7 / nnyy                                                       -> None
```

`meta` 选择器、`int` 变换都已存在 —— 也就是说**两个站今天就能读，一行引擎代码都不用加**。

**读不到的那三个，时长其实算得出来：HLS 播放列表的 `#EXTINF` 之和。**

```text
  jable  1796 段 合计 7181s（1:59:41）   yhdm7  703 段 合计 1405s（23:25）
```

但这是"再取第二个网络文档 + 求和"，**不是选择器能表达的东西**（规则只在已抓到的文档里选值）。
真要做，它是一条**新能力**（一个派生字段），不是给模板加一条规则。

**用户猜的"播放器里显示的时长"这条，实测正是读不到的那三个。** 时长由 Plyr/HLS 在浏览器里从
播放列表算出来，served HTML 里根本没有 —— 与《规则必须在服务端返回的页面上跑，不能只在渲染后的页面上跑》同一个成因。

**这五个站还各自证实了一件事：**

```text
  hanime1  人眼能看到的值（13:25）和稳健规则读到的值（805）**不是同一个值**：
           这一页有 200 个 div.duration（81 条相关推荐）。按"值"去点会学到 div.duration 并读到第一个；
           本片的时长只在 og:video:duration 里。学习器偏好 meta 来源，但用户点的是"值"——
           这是"人点得到的"和"规则读得对"之间的一道真实裂缝。
  jable    详情页只有**推荐卡片**的时长，规则一旦按"这页上的时长"去学，读到的就是别人的片子。
  nnyy     是**系列页**（剧集按钮 ep1..epN），页面默认加载 ep3 —— 连"第一集"都不是，是页面自己挑的那一集。
  yhdm7    地址本身就是第 1 集（`-1-1.html`，播放器里有 `link_next` 指向下一集）；
           jable / missav / hanime1 是单片页，时长唯一。
```

**两半的结论：**

1. **站点侧**：五个站里只有 **2/5** 能从 served HTML 抓到时长，且只存在于 og 元数据里；
   剩下 3/5 需要"取播放列表求和"这条新能力。**时长不是"每条都有的 page"，是"少数站有、多数站没有"的可选事实。**
   标注页那条路能修：`<meta>` 虽在 `<head>` 里看不见，但 harvest 会把 meta 的 content 作为候选提供
   （`Source("markup", …, {"from":"meta", …})`），且 `805`/`5881` 这类纯数字能过 `is_a_value`。
   所以只要标注页有"时长"字段，用户**能点到它**；现在缺的正是字段本身
   （`annotate.FIELDS` / `text.py` 的标签与提示 / `learn.FIELD_TO_RUNTIME`）。
2. **T³ 侧**：`page_count` 是 entries 的列（`004_entry_page_media.sql`），和 `upload_date` 一起住在
   `EntryStatsRow.vue` 的那一行统计里 —— 那正是"与 page 同级"的位置。加时长是一条完整竖切：
   新迁移（仿 004）＋ `entry-repository`（约十处）＋ `db:probe` ＋ 真 SQL 集成测试 ＋ `db:doctor`；
   导入链 `packages/shared` 的 `ImportEntry`、`import/site-probe.ts` 四个 zod schema 与四个 adapt、
   `commit.ts`；站点侧 `_SCALAR_FIELDS` / canonical 记录（可能还要一个"秒 → H:MM:SS"的 transform）；
   UI `EntryStatsRow` 第三个 stat ＋ i18n ＋ `api/gallery.ts`；**外加离线/同步那一半（归另一位）**。

**建议（等用户定，本轮只研究不实现）**：最小可用形态是"entry 上一个可选的事实字段（存秒），显示时格式化，
与 page / date 同排"；采集侧先只支持 `og:video:duration` 这类 meta 规则，播放器/播放列表那条路另立一项能力。
**不要**自动检测（用户已定）；**不要**把时长塞进 `page_count`（页数 ≠ 秒，语义会坏）。
待定一项：是否需要**按时长排序/筛选** —— 要就必须是列，不能塞进 Content。
