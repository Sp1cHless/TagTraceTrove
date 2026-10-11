### 修：500 的"Internal server error"现在自报证据（写日志并在回答里点名）（2026-10-06）

用户：**「interner server error, 点击 import entry 出现 preparing import 然后马上退回到 import entry」**

上一轮的修复生效了（他现在**看得见**那句 "Internal server error" —— 它出现在按钮正上方），
按钮也不再卡在"准备导入"。剩下的是 500 本身。

**先说复现结果：我复现不出来。** 完整跑了四遍（390×844，高级导入 → 贴作品网址 → Apply → 审阅屏 →
点 Import），并把**真实请求体抓了下来**（`JSON.stringify` 是动态调用的，钩住它就能拿到）：

```text
  POST /api/imports/commit-path  →  **37ms，201**，两个条目创建成功、8 张图入库
  请求体核对过：entryType "Comic"、canonicalTagFacetId 132、字段映射 127/128/129/130、
                origin.kind "work"、两个 externalKey（1472965 / 1474863）
  同一份请求体在内存库里也跑通（新建 2 条、8 张媒体、0 warning）
```

所以这个 500 取决于**那台机器的状态**（库/资源/facet id），而不是我能走到的代码路径。

**于是我把 500 改成自报证据** —— 这正是这个项目里工具故障早就有的做法
（`<dataDir>/logs/` 里一份可交给人的日志），HTTP 的未处理异常却一直只有一句"Internal server error"：

```text
  app.onError 的兜底分支：把 method/path/异常（含 stack）写成
    <dataDir>/logs/siteprobe-http-<时间>.log
  回答里点名这个文件：`Internal server error — log: …`
  → 失败自己带着证据，我可以直接从磁盘读它，不必依赖那台机器的终端
```

守卫：`siteprobe-http.integration::writes a log for an unhandled fault and names it in the answer`
（用"同一作品 id 出现两次"这个真实抛错触发 500，断言回答里点名了文件、文件里含 `Duplicate work id`
和请求路径、且落在 `<dataDir>/logs` 下）。

**一个具体怀疑对象（等日志确认）**：`commit.ts:82` 的 `assertFacet` 抛的是
`Facet <id> does not belong to Entry type "<type>"`，而 `isDomainConflictError` 的前缀表
（`cannot ` / `Entry merge ` / …）**不包含它** → 于是落进 500。任何"审阅屏拿到的 facet id 与实际
Entry type 不一致"的情况（例如审阅屏打开后改过 Type/Gallery）都会以这种方式表现成
"Internal server error"，而不是一句能读懂的拒绝。

门：T³ 单测 1111；集成 **611/611**；server tsc 0；eslint 0。
**服务端要重启**（它跑的是源码），网页刷新即可。
