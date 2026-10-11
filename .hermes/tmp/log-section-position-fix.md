
### 修正：多网址的适配器跑起来，标注页是**空白**的（ERR_EMPTY_RESPONSE）（2026-10-04）

用户：**「尝试不同的网站，作品adaptor: … annotation page: http://127.0.0.1:65413/?token=… 结果打开的网页如图」**
（图：Chrome「该网页无法正常运作 / 127.0.0.1 未发送任何数据 / ERR_EMPTY_RESPONSE」）

```text
真因：**`position` 有两个契约**。`annotate.page()` 把它当 `(index, total)` 元组用
（`position[0]` / `position[1]` → 交给 `l10n.position_text` 渲染成「第{cn}个网站（1/3）」），
而 `build_adapter.one_sample` 传的是**已经格式化好的字符串**
（`f"第{CN_NUM[index]}个网站（{index + 1}/{total}）"`）。
字符串的 `[0]`/`[1]` 是两个**字符**（'第'、'一'）→ `position_text` 里 `0 <= index` 抛
`TypeError: '<=' not supported between instances of 'int' and 'str'` → 异常发生在 **HTTP 处理器内部**，
连接被关掉、一个字节都没发 → 浏览器显示 ERR_EMPTY_RESPONSE。

为什么只有这一次踩到：
  · 只在 `total > 1` 时才有 position —— 用户这次是**三个网址**（`build_adapter.py --browser --install
    <sone-430> <ssis-948> <ssis-909>`）；单个网址的跑法 position 是 None，所以不复现（我先用一条网址复现，
    页面 660 KB 正常，就是这个原因）；列表流程也不传 position。
  · 唯一的 position 测试直接调 `page(position=(0, 3))` —— 它证明了页面会渲染元组，**没有**证明流程会传元组，
    两个契约因此长期各说各话。

实测证据链（都在用户那台还在等的进程上量的）：
  · 那个服务器的**其他路由全部正常**：`/` 无 token → 403 `bad token`；`/nope` → 404；`/media?c=…` → 200 / 36 KB；
    只有首页请求收不到任何字节（curl 无响应行、node fetch `UND_ERR_SOCKET`）——所以是"建页那一步抛异常"，不是服务死了。
  · 用**同一个 session** 在本地重放：`page(position='第一个网站（1/3）')` → 复现
    `TypeError: '<=' not supported between instances of 'int' and 'str'`；换成元组 → 640 KB 正常，
    label 是「第一个网站（1/3）」✓
  · 修好后用**用户那条完整命令**（三个网址）再跑：首页 200 / **663 KB**，页面顶部显示「第一个网站（1/3）」✓

修法（一处，去掉第二个家）：
  · `build_adapter.position_for(index, total)` 返回 `(index, total)`（或 None），
    `build_adapter.py` 自己那份 `CN_NUM` 与拼句子删掉——词只有 `text.py` 一处（`position_text`）✓
  · `Session.position` 的类型/注释改成元组（它本来就是页面那边的契约）✓
守卫：`tests/test_annotate.py::test_a_run_with_several_pages_serves_a_page_instead_of_nothing`，
把这条链的三段都钉住——`position_for` 的形状、页面渲染出的语言化标签、**服务端真正发出去的那份文档非空**。
退回旧的字符串形状跑一遍，红在 `assert '第0个网站（1/3）' == (0, 3)` ✓

门：工具 pytest 363；check_undefined_names 73/0；verify_doors 25/25；verify_against_recordings PASS 327/0。
```
