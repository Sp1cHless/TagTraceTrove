
### 修正：作者自身维度仍落进作品概括的真因——离线包装门面丢了参数（2026-10-08）

上一节我把用户第一次报告归因于"进程比代码旧"。第二次报告后**这个归因是错的**：实测服务进程起于 22:08:39（已含 delete 与
`subjectKind`），而用户那条 `外貌颜值` 建于 **22:08:56**，即新服务之后 17 秒。服务端一直是好的。

**真因**：`apps/web/src/offline/offline-api.ts` 里包装门面的

```text
  async createAuthorRatingSlot(authorId, name) { ... online.createAuthorRatingSlot(authorId, normalizedName) ... }
```

——比基类门面**少一个参数**。TypeScript 里"参数更少的函数可赋给参数更多的签名"，所以这处**能通过类型检查**，
于是每次调用都吃到基类的默认值 `subjectKind = 'producer'`：凡是从应用里建的作者维度都进了作品概括。
这也解释了为什么我之前的两条测试都过了 —— 作者页测试挂的是**原始**内存门面，集成测试直接调仓储，
**都没有经过应用真正走的那一层**（`main.ts` 总是包一层离线门面）。

**证据（用户库，只读）**：`subject_kind='author_self'` 的行数为 **0**；最新一行是 `id=30, 外貌颜值, producer, AV,
created_at 14:08:56 UTC`。用户第二次尝试**没有产生新行**——因为同名 producer 行已存在，`createRatingSlot` 按名复用，
于是看着像"又被归到了作品概括"。

**修复（两处，都在包装门面内）**

```text
  1. createAuthorRatingSlot(authorId, name, subjectKind = 'producer')，在线分支把类透传给基类；
  2. 离线分支同样按类走：enqueueRatingSlotLayout(subjectKind, ...) 选分区，槽位回查也按类过滤；
     并且 enqueueRatingSlotLayout 里解析画廊的那一行改成"只有 'entry' 走作品的 type，两个作者类都走作者的画廊"
     （原来写的是"非 producer 走 entry"，会把 author_self 当作品处理）。
  离线且快照里还没有该类的 layout 行时，调用会被**拒绝**（"Refresh this offline copy..."），而不是悄悄写进作品概括的分区。
```

**新测试**（`offline-api.test.ts`）：在线分支断言 `online.createAuthorRatingSlot` 收到 `(9, 'Charisma', 'author_self')`；
离线分支断言此时是拒绝 + 队列为空。**并把修复临时还原验证过它会失败**（"expected spy to be called with
[9, 'Charisma', 'author_self']"，随后恢复）——不然这条测试等于没测。

**顺带系统性排查了同一类 bug**：脚本比对包装门面已实现的 50 个方法与基类 161 个方法的参数个数，
**没有第二处"参数比基类少"**（这类问题就在这一处）。

**给用户的操作**：这一处是**客户端**修复，产物已重建，**强刷页面即可**（不必重启服务；delete 已经在跑着的新服务里）。
门：typecheck 0 / eslint 0 / 单测 **1206** / 集成 **636** / build ✓ / db:probe 49 项 PASS / db:doctor PASS。
