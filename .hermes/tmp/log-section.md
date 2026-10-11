
### 阶段：common template「转正」的两处收尾（进程比代码旧；小说补 General Rating；模板专用退役）（2026-10-04）

用户：**「common template 从 'template专用' 转正好像没有完全做完。advanced setting 里依旧能看到 template专用，
而没有看到 common template。这个是要手动去调整的。同时，新建的 小说 gallery，在创建第一个作品时我直接使用了
common template，但没有 rating —— 设计的 common template 应该有一个 general rating。检查一下哪里缺了什么」**

```text
一、「看不到 common template」的真因：**跑着的进程比代码旧**，不是代码错
  实测（curl 直接打用户当时在跑的那个 8765）：GET /api/templates/common → 400
    {"code":"VALIDATION_ERROR","details":[{"code":"unrecognized_keys",
      "keys":["description","note","generatedFrom"]}]}
  模板 JSON 是「给写代码的人看的文字 + 接口」两用，文件里带 description / note / generatedFrom；
  那台进程仍是严格的 commonTemplateSchema（我把它改成 z.object 是在那进程启动之后）。
  web 侧是 api.commonTemplate().then(…).catch(() => commonTemplate.value = null)，而区块是
  v-if="commonTemplate" —— **失败等于什么都不显示**，读起来就是「这个程序没有 common template」。
  处置：重建 web dist（00:58 那个包早于 01:20 的源码改动）、杀掉 T3.exe 整棵进程树后重新拉起；
       实测 GET /api/templates/common → 200，ratingSlots:["General Rating"] ✓
  顺手留痕：catch 里 console.warn('Common template unavailable', cause) —— 「静默失败看起来像功能不存在」
  这一类已经是第二次了，至少下次 console 里有东西可查。
  教训与旧账同源：**验证要在用户摸得到的那一层**；源码级检查看不出陈旧的进程 / 陈旧的包。

二、小说 gallery 没有 General Rating
  实测（库的只读副本）：rating_slots 里 小说 没有行；template专用 有 1 行（id 16，General Rating）。
  真因不是「没实现」，是**时间差 + 没有第二次机会**：
    · 模板 JSON 当时只有 sections（ratingSlots 是这一轮才加的）；
    · applyCommonTemplate 对「已经有 layout 的 Gallery」是**拒绝**而不是合并（刻意的：结构是人家的决定）；
    · 于是 review 页那扇门只在「这个 Gallery 的第一个作品」时开，错过就再也进不去。
  修：applyCommonRatingSlots（幂等）+ POST /api/templates/common/rating-slots/apply；
      review 的 useCommonTemplate 改用两个都调（apply 之后紧跟 slots，顺序不能反）。
  补：POST …/rating-slots/apply {"entryType":"小说"} → ratingSlotCount:1；
      GET /api/rating-slots?entryType=小说 → [{id:18,"General Rating"}] ✓

三、模板专用 退役（0 作品的脚手架，内容已进仓库文件）
  退役前清点（只读副本）：entries 0 行、entry_tags 0 行；tag_groups 8 行（段 170/175 + 6 个 facet）、
    rating_slots 1 行、rating_slot_layouts 1 行、entry_tag_layouts 1 行、templates/模板专用.*.json 2 个。
  做法：先 better-sqlite3 backup 一份；两个段用**程序自己的** DELETE /api/sections/:id 删（子行级联）；
    rating_slots / rating_slot_layouts 那两行没有任何删除接口（全库都没有），用一次性脚本删。
  实测：GET /api/templates 的 entryType 列表不再有 template专用；GET /layouts/模板专用 → []；
        GET /rating-slots?entryType=模板专用 → [] ✓
  两个 template JSON 是派生物：搬到 .hermes/tmp/retired-template/（先复制后删原件，可回退），没有直删。
  一次自伤与教训：用 Git Bash 的 curl -d 发 JSON body 时中文被按 GBK 编码，小说 变成 "С˵"，
    路由老老实实为这个不存在的类型建了一行 General Rating。**Windows 上带中文的 body 一律从 node 发，
    不要经 shell。**（那条垃圾行随后连同 模板专用 的行一起清掉，脚本按「entry_type 不是真实 Gallery」筛。）

四、量到但**没动**的（同一类，留给用户决定）
  /api/templates 还列着 manga、movie —— 与 模板专用 同一形状：有 tag_groups 行、没有作品。
  没动：用户只点了 模板专用，而 manga/movie 可能是当年真建过、后来条目改过 type 的老 Gallery。

五、仍然挂着的（上一轮用户「只是提醒一下」的那条，不是本次要求）
  模板的 Content 面：description 要像 source url 一样是默认内容（有才显示），用户自己加的第三个 Content
  （比如 comment）点「应用 template」时也要被应用。现状：库里只有 entry_contents(entry_id, content_type,
  content)，**没有「Gallery 级 content 种类」这个模型** —— 所以这不是补一个字段，而是一个小特性。
```

```text
门（本轮代码改动：common-template 的 ratingSlots + 背填路由、AdvancedEditingPage 的 console.warn、
    add-entry-quick 测试补 mock）：
  · apps/server typecheck ✓
  · apps/web typecheck：只剩**对方**的 pending-work-restore.test.ts(86,125) TS2339（mtime 01:24，进行中）✓
  · 服务器单元 + import 套件 95/95 ✓；template-export 集成 5/5 ✓；add-entry-quick 20/20 ✓；
    siteprobe-adapter-status / rule-builder-panel ✓
  · 测试确实能失败（值得记）：add-entry-quick 的 mock 少了 applyCommonTemplateRatingSlots →
    真机上是个 TypeError，被 catch 吞掉后 loadImportLayout 不再执行；测试是在
    「listLayout 只被调了 1 次（期望 2）」上红出来的 —— 症状抓到了，且现在 mock 同时断言两半都被调用。
  · 环境坑：直接 pnpm exec vitest 用系统 node v26 → better-sqlite3 原生绑定加载失败
    （报 "npm rebuild"/bindings），5 条集成测试看起来像全红。正确作法是把
    %LOCALAPPDATA%\hermes\node（v22）放进 PATH：PATH="/c/Users/hzy/AppData/Local/hermes/node:$PATH"。
    T3.bat 里那段「挑一个能加载 SQLite 的 node」是同一件事。
  · 用户那一层（真浏览器，127.0.0.1:8765 → 设置 → 进阶编辑 → Gallery templates）：
    最上面是 "Common template / 2 sections … Ratings: General Rating"；
    下面是 Comic / Hentai / manga / movie / 小说 / 漫画 / 电影 / 真人（没有 模板专用）；
    展开 小说 → "Ratings General Rating ★★★★★" ✓
```
