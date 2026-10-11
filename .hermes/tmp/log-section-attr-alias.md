
### 修正：jable.tv 的作者标了却在导入时不见了（规则读的是"渲染后的属性名"）（2026-10-05）

用户：**「检查一下jable.tv的适配器，单个作品的。做适配器的时候，作者都成功选中了，但是import的时候没有
作者的信息了」**

```text
先量，不猜：适配器本身是对的，坏的是**运行时读不到它学的那条规则**。
  · `local/jable_tv/site.json` 的 `work.fields.author` = `{from: html, select:
    "span.placeholder.rounded-circle", attr: "data-original-title"}`，标注记录里 `creator = 早坂奏音`
    （session `20261005-143642-work1`）——标对了 ✓
  · 导出 `export/jable.tv/sole_work/items/213/metadata.json` **根本没有 `author` 键**，
    `分类信息.作者` 也是空 —— 规则在爬取时读到了空 ✓
  · 同一张页面，两种 HTML（实测）：
      服务端返回（爬虫读的就是它）：`<span class="placeholder rounded-circle" data-toggle="tooltip"
        data-placement="bottom" title="早坂奏音">`
      浏览器渲染后（Builder 抓的、也是它学规则的那份）：`… title="" data-original-title="早坂奏音">`
    ——Bootstrap 的 tooltip 在初始化时把 `title` 搬进 `data-original-title` 并把原属性清空。于是规则
    **对渲染页是对的、对服务页是死的**；而 Builder 的 capture 只有渲染后的 `page`（163 KB，`format:
    markup`），没有任何原始响应体，所以它在授权阶段无法看见这件事。

修法（通用，一处；不动任何适配器、不重学）：运行时的**属性别名表**。运行时本来就用同一套思路处理懒加载图片
（无 `attr` 时依次试 `src, data-src, data-original, data-lazy-src, href`），现在**指名**的属性也走它的别名：
`data-original-title ↔ title`、`src ↔ data-src`、`data-original`/`data-lazy-src → src`。
规则的拼写仍优先（两个属性都存在且含义不同时不会被悄悄换掉），并且每个名字只读一次。
守卫：`tests/test_generic_probe.py::test_a_rule_survives_the_attribute_a_script_moved`（服务页读到值、
渲染页仍以规则自己的拼写为准、懒加载双向），退回旧行为跑一遍红在 `assert [] == ['早坂奏音']` ✓

端到端复验（真站、真产物、走 T³ 自己的消费者）：
  · `probe.py https://jable.tv/videos/snos-213/` → 导出记录现在有 `author: "早坂奏音"` ✓
  · `pnpm import:site-probe <metadata.json> --output …`（T³ 自己的导入器）→
    `fields: {"authors": ["早坂奏音"]}` ✓ —— 正是导入复核里会变成 Producer 的那个字段。

顺带扫了一遍所有已装适配器的规则，同一类还有几处（都是懒加载图片那一族）：
`comic18`/`18comic_vip` 的 cover 用 `data-original`/`data-src`、`manwa_me` 用 `data-original`、
`www_bilinovel_com` 的列表封面用 `data-src` —— 现在它们同样多了一层兜底 ✓

**留下的一条真话（没做，属于"Builder 的验证层"）**：Builder 只在**渲染后的 DOM** 上验证规则，而爬虫读
**服务端返回的 HTML**。别名表盖住了"脚本只是把值换了个属性名"这一类（值本来就在静态 HTML 里，按既有口径这是
我们的 bug）；但"值只有跑完 JS 才有"的字段依旧读不到——那需要在授权阶段保留一份原始响应体来对照，或者爬取时
用浏览器（后者与 Level D 的结论相悖）。这条要不要做，等你定。

门：工具 pytest 364；check_undefined_names 73/0；verify_doors 25/25；verify_against_recordings PASS 327/0。
```
