### 修（第二次）：导入 500 的上一次修复不完整 —— 坏行不该拦住导入（2026-10-06）

用户：**「一样的报错，看一眼log。修复真的完成了吗，还是又没有build」**

log 里还是同一条（01:02 两次）：`taxonomy alias cycle detected`。两件事要说清楚。

**一、不是 build 的问题，是"上一次修复不完整"。** 服务端跑的是源码（`tsx src/http/server-cli.ts`），
不需要 build，但**必须重启**才生效。而更要紧的是我上一轮只做了**清理**（迁移那一趟删掉自环行），
**导入本身**在清理之前依然会抛：

```text
  上一轮：importSiteDictionaries 里删掉"简化后 alias == canonical"的行
          → 但那只在**点那个按钮**时发生
          → 用户直接重试导入 → 库里那 591 行还在 → resolveTaxonomyName 照样抛 → 照样 500
  这是我把"防"当成了"修"：**坏掉的字典行不该能拦住一次导入**。
```

**二、真正的修法：走不动就停下，而不是失败。** `resolveTaxonomyName` 遇到环时**返回它走到的那一个名字**，
不再抛：

```text
  · 提交一个作品会解析它带的每一个 tag → 一行坏数据 = 那个站点**每一次导入都 500**（实测 591 行）
  · 环是"字典里的一行坏了"，不是"这次导入不合法"；两者的处置不该一样
  · 返回环闭合处的名字 —— 那正是那些行所写的，也是人读字典时会预期的结果
  · **拒绝新建环**这件事仍然保留在它该在的地方：writeTaxonomyAlias 会把即将闭合的链解析一遍，
    回到自己就拒绝（实测：A→B 已存在时写 B→A 仍被拒 ✓）
```

上一轮的清理仍然保留（卫生），但现在**不清理也能导入**。

守卫：`taxonomy-repository.integration::imports a work even when the dictionary holds a row that points
a name at itself`（库里放一行自环 → 断言解析不抛、且 `commitImportBatch` 能把带该 tag 的作品提交成功）。
退回抛错 → 红，报的正是用户看到的那句 `taxonomy alias cycle detected` ✓

**关于"是不是又没 build"**：查了运行中的进程 —— 服务端启动于 **01:01:31**，而我的改动时间是
`import-dictionaries.ts` 00:59:26（**已加载**）、`taxonomy-repository.ts` **01:04:44（未加载）**。
所以他 01:02 的重试跑的是"有清理、但导入仍会抛"的那一版 ✓ 与现象完全吻合。

门：T³ 单测 1111；集成 **613/613**；server tsc 0；eslint 0。**重启服务端即可**（无需 build）。
