from guard import ROOT,STAGE,edit,sha
from pathlib import Path
import json,difflib
p='.hermes/artifacts/offline-parity-author-implementation.md'
old=(ROOT/p).read_text();anchor='## Checkpoint / evidence'
section='''## gap4 bounded continuation — latest checkpoint (partial, not gap4 complete)

- 本writer只修改 GalleryApp.vue、offline-api.ts、stores/preferences.ts、本integration tracer和report；production/test现已停写。当前 **gap4仍未完整闭合，02仍WORKING，03 NOT_STARTED**。没有重开已GREEN的Directory-delete/held/cascade cells，原10tests仅回归。
- 完整验证directory checkpoint manifest SHA `13bdf0d6d7c9e6763fd0e4ddc926a40c2a6a67e4fc5d7d279f922c2434e2537a`与13项live==saved==ledger后，独立保存gap4-start原完整bytes；新纳入GalleryApp/preferences实际dirty pre-edit bytes，不从HEAD恢复。
- GalleryApp 的 `creationView='author'` branch/submitAuthor既有，但普通入口没有任何调用openCreation('author')。新建入口RED：`gap4-entry-red.log`要求实际sidebar按钮不存在；最初按英文Add Author文本查找失败记为selector/setup，不冒充准确业务断言。最小恢复sidebar普通New Author按钮使用既有author.new翻译+openCreation。该函数清collections/random等view，submit后showAuthors→authorTarget实际direct detail/Edit通过；**旧Collections/Random出发的专门caller变体未新增证明**。
- `gap4-cold-red.log`真业务RED：冷IDB新Author实际Tag输入提交后tags仍为空。三个Producer enqueue family仅查baseline身份；改为仅同client/library/epoch producer.create投影供应initial revision，既有updates仍独立计同Producer version advances。无旧envelope改写或默认字段注入。
- `gap4-green-2.log`真业务RED：View later实际button提交后facade membership为空（不再是编辑态selector错误）；viewlater/rating overlay仅查snapshot旧Producer。改为已投影Producer identity。preferences对facade Author state保留safe非零negative localID，legacy localStorage/Entry/HTTP positive规范化未改；actual button aria-pressed=true证明当前UI保留本地membership。rating两classes覆盖为本tracer后续first-GREEN，不宣称独立rating缺陷RED。
- 新tracer实际GalleryApp New Author→AddAuthorPage所有fields→直接detail→实际profile表单name/occupation/artwork/content→冷fakeIDB负numericID且稳定UID→真实AuthorPage tag/ViewLater；Gallery anchor及两class共享layout创建/rating用production facade（**未宣称这三项actualUI手势证明**）→origin-backed联既有Work→真实app.request/迁移memorySQL→create response-loss→冷ACK-loss→再次冷exact原UUID/body重试→同一UID单Producer numericID、profile/tags/ratings/viewlater/Work刷新和outbox cleanup。workless list隐藏/direct detail保持。原requests canonical bytes不追加字段；每original重复body字符串Set=1。
- 当前focused11/default1239/integration705：success=true、failed0、pending0；shared/server/web types、rootlint、diff PASS；T3_SW_BUILD=1隔离client Vite PASS（完整输出保留）。不是SW/PWA/APK/手机/TCP证据；没有新nativecontract/Java/fixture改动，没有重跑历史JVM61，也没有新production Worker timeline证明。
- **第一未闭合仍gap4：新Author在未replay前的独立Directory-set scope身份供应，以及联作品后的实际Directory UI冷编辑纵向。** producer.create只持Producer UID；server INSERT触发创建随机独立Directory-set UID，现create envelope没有可信预供identity，不可假定两UID相同或猜scope。需要新的未seal create显式向后兼容scope字段+新cap failclosed，并协调共享/server/native/restore+真实JVM；本轮未启动这项合同扩展、未留新未实现Directory RED。不用在线-only禁用冒充完成。
- gap1其余完整negative、gap5 restore完整矩阵、gap6 connected/cap/旧fieldunknown/错误snapshot、gap7 production native timeline按原状态继承，均未宣称闭合。本组可用GREEN只属于上述bounded cells；预算收束不等于已完成用户要求完整gap4。
- 最新fullbytes checkpoint `.hermes/tmp/offline-parity-author/gap4-checkpoint/manifest.json` 包含全部ledger sources/tests/report、gap4-start diff、exact saved report哈希、当前真实JSON/log和隔离Web。旧before/continuation-start/continuation-02-start/directory-start/各checkpoint不覆盖。父继续维护CURRENT/board，本writer不修改。
- 未read/touch/request正式DB/assets/8765/8766；未改migration/v45 cache三文件/媒体/PairedTransport/NativeAuth/pinning/APK/version/signing；无commit/reset/stash/checkout/deploy。

'''
assert old.count(anchor)==1;edit(p,anchor,section+anchor)
ledger=json.loads((STAGE/'ledger.json').read_bytes());start=STAGE/'gap4-start';sm=json.loads((start/'manifest.json').read_bytes())
for path in ['apps/web/src/stores/preferences.ts']:
 b=(start/path).read_bytes();sm[path]={'current':sha(b),'bytes':len(b)}
(start/'manifest.json').write_text(json.dumps(sm,indent=2))
out=STAGE/'gap4-checkpoint';assert not out.exists();out.mkdir();manifest={'status':'WORKING_NOT_OWNER_GREEN','scope':'gap4 partial bounded cells GREEN; new Author Directory-set identity still missing','source':{},'evidence':{},'web':{},'gates':json.loads((STAGE/'gap4-gates.json').read_bytes()),'native':'NOT_RERUN unchanged contract/fixture; new timeline UNVERIFIED','firstGap':'gap4 new Author unreplayed Directory-set identity + actual Directory cold/replay vertical','nextOwner03':'NOT_STARTED','inheritedOpen':'gap1negative/5restore/6connected-capflags/7native','priorCheckpointSha256':sha((STAGE/'directory-checkpoint/manifest.json').read_bytes())}
for path,v in ledger.items():
 b=(ROOT/path).read_bytes();assert sha(b)==v['current'],path
 q=out/path;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b);assert q.read_bytes()==b
 manifest['source'][path]={**v,'bytes':len(b)}
 before=start/path
 if before.exists():
  diff=''.join(difflib.unified_diff(before.read_bytes().decode().splitlines(keepends=True),b.decode().splitlines(keepends=True),fromfile='gap4-start/'+path,tofile='current/'+path));d=out/'scoped-diffs'/(path+'.diff');d.parent.mkdir(parents=True,exist_ok=True);d.write_text(diff)
for f in STAGE.glob('gap4-*'):
 if not f.is_file():continue
 q=out/'evidence'/f.name;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(f.read_bytes());manifest['evidence'][f.name]=sha(q.read_bytes())
for f in (STAGE/'gap4-client-build').rglob('*'):
 if f.is_file():
  rel=f.relative_to(STAGE/'gap4-client-build');q=out/'web'/rel;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(f.read_bytes());manifest['web'][str(rel)]=sha(q.read_bytes())
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
for path,v in manifest['source'].items():assert sha((ROOT/path).read_bytes())==sha((out/path).read_bytes())==v['current']
for k,v in manifest['gates'].items():
 if k=='exitCodes':assert all(code==0 for code in v.values())
 else:assert v['success'] and v['numFailedTests']==0 and v['numPendingTests']==0
print('VERIFIED fullbytes',len(manifest['source']),'manifestSHA',sha((out/'manifest.json').read_bytes()))
print(json.dumps(manifest['gates'],indent=2));print('REPORT SHA',manifest['source'][p]['current'])
