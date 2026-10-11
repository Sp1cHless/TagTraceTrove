### 字典统一：内置繁简转换 + 字典搬进 T³（分类抛弃、迁移 2004 条）（2026-10-05）

用户：**「就按你建议的来。还有，之后的流程中就不需要本地的字典了，tag都直接入库了，也没有额外手动处理字典的必要。直接全部在 tag aliase 中处理就行。」**

**1. 繁简转换内置进 T³（这一步单独就修掉了"繁体直接入库"）。**

```text
  引擎：opencc-js（离线、确定性），配置与工具用的 OpenCC t2s 相同
  实测：把七个站点字典里的 **7709 个名字**两边各转一遍 —— 完全一致，0 处不同
        （两边不一致的话，迁移时"这条是工具自动填的"就会误判）
  落点：resolveTaxonomyName() 是**唯一**决定"这个名字最终变成什么"的地方 ——
        进来先转简，没有别名就返回转简后的名字；别名行两侧也按转简存
        → 繁体和简体是**同一行**，不是一个名字两个条目
        assignEntryTag / renameEntryTag（cleanDisplayName）与 createProducer / updateProducer
        也走同一条规则，否则手输繁体就会在导入的简体旁边再建一个 tag
```

**2. 分类（series/characters/tags/authors）抛弃 —— 依据是"它从来没被读过"。**

```text
  · resolveTaxonomyName 的查询是 WHERE vocabulary = ? AND normalized_alias = ?
    → partition 只是分组显示的标签，解析从不使用；
  · 真正的分类是 **Facet 归属**，而且导入时是学出来的：majorityFacetForTag 把 tag 放进它
    在本画廊里待得最多的那个 Facet；新 tag 先落在无名 Facet，由「未分类 Tag 归位」页处理；
  · 所以字典里的分区是**第三个说法**，而且是不被读的那个。
  改法：字典页只剩两组 —— **已映射 / 还没有对应**；作者半边移除（它有独立的「作者别名」页，
        写的是同一张表的 producer 行，`author-alias-repository.ts` 直接调 upsertTaxonomyAlias）。
```

**3. 一次性迁移：把工具写在 export 树里的字典搬进别名表。**

```text
  入口：字典页一个按钮「把各站点字典一次搬进来」→ POST /api/taxonomy-aliases/import-site-dictionaries
        （服务端本来就知道工具 home，不必再手动选文件）
  规则：只搬**人做过的决定** —— canonical 恰好等于"内置转换会得到的那个"就跳过（那是工具自动填的）；
        producer 的空 canonical 不搬（实测：七个字典的 authors 节共 1340 条**没有一条翻译**，
        而 listAuthorAliasGroups 对空 canonical 的行**什么都不显示**，搬过去就是 1340 行死数据）
  真实数据实测：7 个站点 → 搬进 **2015** 行（其中 2004 条真翻译），跳过 1914 条，
        待定队列 11 个（Doujinshi / Image Set / Manga / Artist CG / Game CG …）
```

顺带把解析器移到 `packages/shared`（web 与 server 读同一份文档，两份实现必然漂移），
并让 `importTaxonomyAliases` **跳过"说了等于没说"的行**（否则迁移里一条冗余行会让整批失败）。

守卫（都退回旧行为跑红过）：

```text
  · taxonomy-repository.integration：繁体入库即转简 / 无字典也能转 / 英文原样不动 /
    繁体与简体是同一行 / 别名=它自己的简体形式时不新增行
    把 toSimplified 换成恒等 → 2 条红 ✓
  · site-dictionary-import.integration：只搬人做过的决定、跳过转换能覆盖的、空 canonical 不搬作者、
    重跑不重复
  · packages/shared/tests/taxonomy-dictionary：分区被抹平（断言没有 partition 字段）
  · gallery-app.test：字典页两组（已映射 1 / 待定 1）、迁移按钮调用与摘要
```

门：T³ 单测 1109；集成 **608/608**（`delta-payload` 那条既有抖动这次也过了）；
server/shared tsc 0；web vue-tsc 0；eslint 0；工具 pytest 379。

**没做、需要你定的两件事**：

1. **`rejected` 没有搬**（hitomi 441 条 + 18comic 62 条）。`parseTaxonomyDictionary` 只读 `accepted`，
   而这些 tag 目前是被**爬虫**在写 `分类标签` 时丢掉的 —— 所以它们还没进库，也没丢。要不要在 T³ 侧
   做一个"不创建这些 tag"的黑名单（需要一条新 migration），是独立决定；不做的话它们继续由工具拦着。
2. **工具的本地字典没有删**。它现在只是迁移来源，运行期 T³ 完全不依赖它。删掉它的写入逻辑是工具侧的
   改动（会牵动 `verify_against_recordings` 那 327 条比对），等你说了再动。
