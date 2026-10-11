### 修正：离开页面后，仍在跑的任务能拿回来（第三项：超时——量过之后不做）（2026-10-05）

用户：**「继续做，不造成冲突就行」**（承接上一轮的风险清单；并先纠正了我上一条把三项都说成"另一个 AI 的 UI 文件"
的错误——实际只有 `AddEntryPage.vue` 里 8 行 offline prop 是共享面）。

**1. 两个面板在挂载时接管仍在跑的任务。** 任务跑在服务端的子进程里，离开页面并不结束它；面板以前会**彻底忘掉**
它——进程继续跑，没有日志、没有状态、也没有"重新开始"能停掉它。新增 `GalleryApi.listSiteprobeRuns()`
（服务端 `GET /api/siteprobe/runs` 早就有，前端从来没调用过），两个面板各自取**最新的 running 任务**接管：

```text
  · RuleBuilderPanel：command === 'build'。按 job.kind 回到它所属的那一半（work / listing），
    把 job.input 里的地址放回输入框（地址里没有空格，所以按空格切分是精确的）；
  · AdvancedImportPanel：command === 'run'。把 job.site 与 job.kind 还原到选择器里 ——
    这不是装饰：**停止按钮就在选中 kind 的那个块里**，只还原任务不还原 kind，
    会得到一个"看得见但停不掉"的运行，也就是同一个抱怨往下错了一层（第一次实现正是如此，测试当场红）。
```

**只接管 running**，不接管已结束的：已结束的任务该写的都写了（适配器、或那句拒绝），几小时后再把它摆出来
是给用户看一个他早就走过去的状态。这里要救的是**活着的进程**，不是结束任务的记录。

**2. 预览不再把人从别的页面拽走。** `applyImportPreview` 以前无条件 `activeTab = 'import'`。现在多一个
`from` 参数（发起它的那一页），**只有人还站在那一页时才切**；否则审阅页在导入页等着，回去就能看到。
三个门各自传自己的页：文件夹拖放传 `files`，两个面板分别传 `advanced` / `rules`（模板里分开绑定）。

**3. 构建的空闲超时 —— 量过之后决定不做。** 先量了能不能知道"人还在不在"：

```text
session_server.serve() 的等待循环：while not session.done.wait(timeout=HEARTBEAT)
  HEARTBEAT = 30，每 30 秒打印一行 "still waiting ... Ns"
  除此之外没有任何信号：标注页是静态 HTML，人读它、标它，不发任何请求
```

所以没有"人还在"的判据，任何超时都是**拿人的节奏去猜**，而设计上这里就是"人是时钟"（`transport.ts`
的注释：the person is the clock）。一个慢的标注是合法的，杀掉它比留着更糟。真正被抱怨的缺陷是
"看不见也停不掉"，而第 1 项已经把它修掉了（面板现在显示还在等多久，并且"重新开始"就是取消，
服务端是整棵进程树 `taskkill /T /F`）。真正还需要的是**T³ 被杀掉之后**那个孤儿——那要靠工具侧检测
父进程消失，是另一件事，也属于工具的改动面，没有做。

守卫（三条，都退回旧行为跑红过）：

```text
  · rule-builder-panel.test.ts::takes back a build that is still running when the page is opened again
    （还断言了"重新开始"会 cancel 掉它接管的那个 id）+ ::leaves a finished build alone
    去掉接管 → 页面停在 intro（expected true to be false）✓
  · advanced-import-panel.test.ts::takes back a crawl that is still running when the page is opened again
    去掉接管 → 连日志块都找不到 ✓
  · gallery-app.test.ts::leaves the person on the page they moved to while an import was being prepared
    （用一个可控的 promise 把"准备文件夹"卡住，中途切到另一页，再放行）
    改回无条件切换 → 人被抓回导入页 ✓
```

门：工具 pytest 379；未定义名 74/0；doors 27/27；录制回放 327/0。
T³ 单测 1107（新增 4）；集成 603/604（仍是 `delta-payload` 那条既有的并行超时抖动，与本轮无关）；
server/shared tsc 0；web vue-tsc 0。
