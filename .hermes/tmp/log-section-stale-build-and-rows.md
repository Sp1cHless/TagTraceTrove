### 修：构建产物是旧的 + 旧行没有跟着改简（用户：「重启后还是原样」）（2026-10-05）

用户：**「重启后还是原样，检查一下build没有」**（截图里还是 Series 348 / Characters 1831 /
Work types 5 / Tags 469 / Authors 1517 —— 旧的按分区分组的样子）。

**1. 构建产物确实是旧的。** 这正是那条纪律：**要在用户真正碰到的那一层验证**。源码改了、测试全绿，
但浏览器读的是构建产物：

```text
  apps/web/dist   ← 10-04 19:05
  src/*.vue       ← 10-05 22:09
  → 重新 pnpm --filter @t3/web build，然后在**产物里**核对新文案：
      "Bring in every site dictionary" / "Not mapped yet" / "把各站点字典一次搬进来" /
      "还没有对应" / "改成了简体" 全部命中 ✓
```

顺带确认了两件事：服务端跑的是源码（`tsx src/http/server-cli.ts`），所以**服务端要重启**才生效；
`dist` 是每次请求从磁盘读的（`serveStatic` + SPA 回退读 `index.html`），所以**前端只要刷新**。

**2. 更要紧的一件：库里已有的行没有跟着改简。** 用户截图里的数字暴露了这一点 —— 他的库里早就有
按分区导入过的别名（2653 entry + 1517 producer）。而那些行的身份键是**旧规则**写的，实测：

```text
  库里一行（旧规则写）：乳膠衣 → 內衣，键 = 乳膠衣
  修之前：resolve('乳膠衣') → 乳胶衣   ← 翻译「內衣」静默丢失
          resolve('乳胶衣') → 乳胶衣
```

因为查表现在会先把输入转简（`乳胶衣`），而那一行的键还是 `乳膠衣` —— **对不上**。
所以迁移必须同时**重写已有行**，我上一轮漏了这一步。修法：一次性迁移里先做一遍
`simplifyStoredAliases()`：

```text
  · 把每行的 alias / canonical 转简，连同 normalized_* 一起写回；
  · 两种写法变成同一个名字时折叠成一行 —— **保留有映射的那一行**（什么都不说的行价值更低），
    折叠数如实报告，因为被折叠掉的那条映射确实没了；
  · 先 DELETE 再 UPDATE：否则要改写的那一行会撞上另一行还占着的 UNIQUE (vocabulary, normalized_alias)
    —— 这个 bug 是实测抓到的（第一次跑就 SQLITE_CONSTRAINT_UNIQUE）。
  修之后：resolve('乳膠衣') 和 resolve('乳胶衣') 都 → 内衣 ✓
```

守卫：`site-dictionary-import.integration::re-writes the rows that were stored before the library
converted anything`（旧行 + 两种写法折叠；退回旧行为红）。

门：T³ 单测 1109；集成 **609/609**；server/shared tsc 0；web vue-tsc 0；eslint 0；工具 pytest 379。
产物已重建并核对。
