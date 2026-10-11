### 修：导入 500 的真因 —— 我的迁移造出 591 个"自己指向自己"的别名（2026-10-06）

用户：**「好，log也存好了」** —— 上一轮加的日志拿到了真因，一句就够：

```text
Error: taxonomy alias cycle detected
    at resolveTaxonomyName (taxonomy-repository.ts:108)
    at addTag (commit.ts:307)
    at commitImportBatch → commitSiteProbeExportPath → POST /api/imports/commit-path
```

**这是我自己上一轮引入的 bug，机制完整还原：**

```text
  工具字典里有一类配对：黃泉 → 黄泉（繁体拼写 → 它自己的简体）
  迁移时它作为一行写进去 —— 此时 alias `黃泉` ≠ canonical `黄泉`，完全合法
  然后**同一趟迁移**把已有行按新规则改简：alias 变成 `黄泉`
  → 这一行变成"名字指向它自己"
  → resolveTaxonomyName 顺着它走成环 → 抛 → 整批是一个事务 → 整个提交 500
  → 于是**那个站点的每一次导入都 500**（不是偶发）
  实测（只读走 API 读字典，没有打开正式库）：**591 行**，环长分布 {"1": 591}，
  全是自环，没有更长的环
```

`importTaxonomyAliases` 本来就有"说了等于没说的配对跳过"这条规则 —— 但**改写那一趟**（我后加的
`simplifyStoredAliases`）没有做同样的检查，而它恰恰是制造这种行的地方。同一个规则，两处实现，漏了一处。

**修法**：改写那一趟把"简化后 alias == canonical"的行**直接删掉**（它不携带信息 —— 内置转换本来就会
把 `黃泉` 变成 `黄泉`），而不是留着让它成环。**用户现有的 591 行也会被同一次迁移清掉**
（再点一次那个按钮即可），守卫断言了这一点。

**顺带确认不变式没有被破坏**：更长的环（A→B→C→A）在写入时就会被拒 ——
`writeTaxonomyAlias` 会把新行的 canonical 解析一遍，`C→A` 会解析回 `C` 自己 → 拒绝 ✓。
所以现在环不可能再被引入，`resolveTaxonomyName` 保留抛错是安全的。

守卫：`site-dictionary-import.integration::drops a row the simplification turned into a name mapped
to itself`（把行改成自环、跑一趟、断言行被删且名字仍能解析）。去掉那段删除 → 红（`merged` 为 0）✓

门：T³ 单测 1111；集成 **612/612**；server/shared tsc 0；eslint 0。
