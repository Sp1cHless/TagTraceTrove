
### 修正：时长写不进 Entry 的真因——服务进程比代码旧（而不是格式不对）（2026-10-08）

用户报：在 Entry 里输入 `7:50` 得到 `Invalid request`。**这不是格式问题**——`7:50` 是合法的 `m:ss`，
`parseDurationSeconds('7:50')` = **470**（与已固化的 `2:02` → 122 同形，也已补进测试）。是**服务端把整个请求体拒了**。

**实测（对当时活着的服务，非破坏性探针）**

```text
  PATCH /api/entries/999999  {"durationSeconds":470}
    → 400 VALIDATION_ERROR  "Invalid request"
      details: unrecognized_keys: ["durationSeconds"]        ← 它根本不认识这个字段
  PATCH /api/entries/999999  {"pageCount":5}
    → 404 "entry not found"                                  ← 同一路径/方法，schema 过了，才轮到找不到条目
  GET   /api/sync/capabilities → sqliteSchemaVersion: 38
```

`unrecognized_keys` 说明：**跑着的服务进程（PID 30588，起于 18:42:50）早于本次改动**（代码是 19:37 之后写的），
它的 `updateEntryRequestSchema` 是旧的 `strictObject`，多一个键就整条拒绝；而我 19:47 重建的 web 产物是新的，
所以输入框在、值也解析对了，请求照样被回绝。**这是《进程比代码旧》那一类，不是字段或格式的问题。**
同一个探针还顺带纠正了我先前的一次误判：用 `PUT` 探路得到 `404 Route not found`，是因为**客户端用的是 `PATCH`**
（`api/gallery.ts` 的 `updateEntry`），不是没有这条路由。

**顺带查清的一件事：正式库是什么时候被迁移的**

`apps/server/.data/library.db` 里 038 的 `applied_at` 是 UTC 11:37:40 = **本地 19:37:40**，也就是我写下
`038_entry_duration.sql`（19:37:36.87）之后 3.4 秒。`.data` 下那一秒只有 `library.db-wal` 变了，
`listener.lock` / `authorization.json` 都停在 18:42–18:43 —— 所以**没有启动过第二个服务**。真因是：

> `buildSyncCapabilities()` 内部调用 `applyAllMigrations()`。客户端下一次请求 `/api/sync/capabilities`，
> 那个 18:42 的旧进程就顺手把新出现的 038 应用到了正式库。

这是本仓库一条值得记住的行为：**新增一个迁移文件，不需要重启，下一次 capabilities 轮询就会落到正式库上。**
本次它是无害的（一个可空列 + 一条 `schema_migrations` 记录）。

**给用户的结论**：重启一次默认服务即可（走托盘/桌面启动器，不要强杀——属主锁在强杀后会静默丢掉加密监听那一个）。
库已经是 38、列已在，重启后不需要再做别的。**我没有重启它**：CURRENT.md 明确要求不动正式 `library.db` 与默认 server，
而且强杀会让手机配对那条加密监听出问题。

**本轮补的测试**：`http-routes.integration.test.ts` 新增一条走**真实 HTTP 面**的用例（POST 带 `durationSeconds:470`
→ PATCH 改成 3756 → PATCH 置 null → GET 复查），外加 `duration.test.ts` 补 `7:50`/`07:50`。
门：typecheck 0、eslint 0、单测 **1202**、集成 **632/632**。
