### 兜底：被打断留下的中间产物（坏适配器、半截 site.json、没落盘的图片）（2026-10-05）

用户：**「动手。目前我使用下来，有多次打断，并没有看到什么后果。因此修复的方案也要以兜底、稳定为主。」**

按"兜底优先"只做了三件事，全部是**已经量出后果**的，UI 层那三项（重新接管、超时、抢标签页）没做，
理由在最后一节。

**1. 一个读不出的适配器不再拖垮整个注册表。** `discover()` 原来把 `load_template` 直接写在循环里，
一个坏文件就是全局故障。实测（把一个写到一半的 `site.json` 放在一个好适配器旁边）：

```text
旧 discover：JSONDecodeError 抛出 → 好站点也读不到（循环根本没返回）
新 discover：返回 ['good.site']，并把坏的那个记进 unreadable_sites()
```

报告走 `--list-sites`（`shadowed_sites()` 旁边的那一行），因为"我建的站点从列表里消失了"是这件事
唯一的对外症状：

```text
(unreadable)     …\local\cut_site: JSONDecodeError: Unterminated string starting at: line 3 column 11
```

**2. `site.json` 改成原子写。** 工具里所有其它写入早就走 tmp + replace（`export_layout.write_json`、
`crawl_state.save`），只有 `roundtrip._write_json` 是原地截断。实测：旧写法在序列化失败时留下
`{"key": "second", "bad": ` —— 一个读不出的适配器，配上第 1 条修之前的状态就是全局故障。
新写法失败时目标文件保持原样，临时文件也清掉。

**3. 提交两半之间被打断的图片，重跑时补齐。** 这是唯一"不可逆"的一条。提交是"先数据库事务、后媒体文件"，
只有前半是原子的；实测把两者切开：

```text
切断之后     -> entries: 1 | coverRef: (none) | previewRefs: 0
旧行为重跑     -> created: 0 | skippedExisting: 1 | mediaStoredCount: 0   ← 图永远补不回来
```

修法两层：
* `commitImportBatch` 现在把"已在库里的那些作品"和它们各自的 Entry **配对**返回
  （`skippedExisting`），媒体那半因此能走到批次的**每一个**作品，而不是只走新建的；
* `storeExportMedia` 的重跑分支按**槽位**续写：一份完整的写入是从左到右填满导出的序列，
  所以已存的是它的前缀，`previewRefs.length` 就是填到哪儿了。**只有空封面会被补**
  （已有的封面是用户自己挑的，编辑器让人换封面，重导不能把它改回去）。

为什么是"槽位"而不是"按内容判断这张图在不在"：既有测试钉住了一个反例 ——
一份导出里两张预览**逐字节相同**是合法的（`stores every preview in the export order`），
按内容判重会把第二张当重复丢掉。第一次实现就是这么写的，测试当场变红（stored 2 / expected 3）。

实测（修后）：

```text
重跑         -> mediaRepairedCount: 2 | duplicates: 1（第二张预览就是封面）→ 封面与预览都补上
第三次导入     -> mediaStoredCount: 0 | previewRefs: 1（不再增长）—— 与"从未被打断"的对照完全一致
```

浏览器上传那条路（`files` 标签页）是同一个形状，只是文件在浏览器手里：服务端没有字节，补不了。
所以在那条路上也加了同一条兜底（`AddEntryPage.vue` 里 `---- interruption repair ----` 标注的一段，
只填**空**的封面/预览，因此不可能重复），并明确注释了它与服务端版本的能力差别。

守卫（四条，都退回旧行为跑红过）：

```text
  · apps/server/…/site-probe-media-repair.integration.test.ts（3 例：重跑补齐 / 与未中断的对照一致 /
    不动用户挑的封面）；旧行为下重跑后 coverRef 仍是 (none) ✓
  · apps/web/…/gallery-app.test.ts::finishes the pictures of a work an interrupted import left behind
    旧行为下 uploadEntryMedia 调用 0 次（旧循环只走 result.entries，而它是空的）✓
  · siteprobe/tests/test_roundtrip.py::test_one_unreadable_adapter_does_not_take_every_other_site_down
    旧 discover 抛 JSONDecodeError ✓
  · siteprobe/tests/test_roundtrip.py::test_a_json_write_that_fails_leaves_the_previous_file_whole
    旧写法留下 '{"key": "second", "bad": ' ✓
```

**没做的三项，及理由**：挂载时用 `GET /runs` 重新接管仍在跑的任务、给构建加空闲超时、
`applyImportPreview` 不再抢标签页 —— 它们不是"兜底"而是行为改动，而且全在另一个 AI 正在改的 UI 文件里；
其中"抢标签页"那一条也**不影响产物**（只是界面跳一下）。风险清单里保留，等 UI 那边稳定了再说。

门：工具 pytest 379；未定义名 74/0；doors 27/27；录制回放 327/0。
T³ 单测 1103（新增 1）；集成 603/604（`delta-payload` 的 `utf8-session` 一例是**既有的超时抖动**：
单独跑 11/11 通过，全套并行跑必超 5000ms；把本轮新增的测试文件排除掉仍然复现，与本轮无关）。
server/shared tsc 0；web vue-tsc 0。
