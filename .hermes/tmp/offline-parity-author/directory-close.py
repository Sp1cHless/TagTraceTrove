from guard import ROOT,STAGE,sha
import json,difflib
# Verified execution results, not a successful report-writer exit.
counts={}
for label in ['focused-closure','default-closure','integration-closure']:
 j=json.loads((STAGE/('directory-'+label+'.json')).read_text());assert j['success'] and j['numFailedTests']==0 and j['numPendingTests']==0
 counts[label]={'success':j['success'],'passed':j['numPassedTests'],'failed':j['numFailedTests'],'pending':j['numPendingTests']}
report='.hermes/artifacts/offline-parity-author-implementation.md';p=ROOT/report;ledger=json.loads((STAGE/'ledger.json').read_text());b=p.read_bytes();assert sha(b)==ledger[report]['current'];old=b.decode();text=old
old2='2. **FIRST GAP：owned Directory-set独立owner映射/因果settlement仍未闭合**。新增held Entry Author实际业务RED：SQL作者被提前删除；现entry.authors.set映射base与desired Producer UIDs、create-and-link映射base+new Producer UID，producer.delete reverse-reference predecessor加入真正mutationQueuePlan。held引用Entry挡删除、独立Entry推进、恢复held后清空GREEN。Collection现有producer reference因此也被reverse graph纳入，但未新写Collection held实际测试，不能称该cell通过。author.directories.set封包只有directory arrays，author_directory_set UID需可信snapshot.authorDirectorySets→Producer UID映射，不可猜UID或跨owner直接比较version。目录receipt被后续delete消失的因果settlement仍缺，下一轮先补此真实RED。'
new2='2. **本次限定 Directory/Collection predecessor cells 已闭合**。Directory held 真业务RED：Producer被提前删除（directory-red.log）；现从可信snapshot.authorDirectorySets的独立UID经producerId映射到Producer UID，持久foreground ownedScope绑定original envelope fingerprint，ACK-loss后仅复用精确匹配。unknown mapping failclosed；planner无mapping时保守把先行Directory纳为Producer delete前驱。held Directory及Collection Producer membership阻断删除且独立Entry推进，解除held后真实SQL replay+ACK-loss/cold exact retry清空GREEN。Directory receipt被删除的结算绑定原UUID/独立Directory owner/library/epoch与已验证Producer delete journal/absence/cursor，跨owner只比serverSeq，不比较两种version。unknown scope/raw native JSON、wrong receipt UUID、noncausal receipt seq三个有限拒cleanup测试first-GREEN；不是完整伪receipt/restore/native安全矩阵。'
old3='3. 删除cascade完整矩阵缺少：本人tags/Directory/ratings/ViewLater/Collection关系清除；其他Author/作品/shared slots/layout保留；Directory-set独立owner receipt被后续delete移除的严格settlement。'
new3='3. **本次相关cascade有限cell已闭合**：实际GalleryApp→AuthorPage双Work拖放创建Directory→移出→改名→移回→普通双确认Author删除；cold facade本人absence、本人新Directory成员查询total0、peer Author/Directory/Collection/ViewLater及两作品保留。真实SQL snapshot本人tags/Directory-set/Directory/ratings/ViewLater/Collection relationships清除；其他Author及其关系、所有作品metadata、共享rating slots/layout和Collection主体保留。Entry关系解除正常推进其自身version+1、Collection保留成员position可压紧，不宣称原revision/index不变。新local-cascade-red.log真业务RED为已删除新Directory仍返回两作品；按producerId滤掉新/旧Directory members后GREEN。'
for a,c in [(old2,new2),(old3,new3)]:assert text.count(a)==1;text=text.replace(a,c)
# Prior gate sections remain explicitly historical.
a='## Continuation-02 current execution boundary';assert text.count(a)==1;text=text.replace(a,'## Prior continuation-02 execution boundary (historical)',1)
a='旧working-checkpoint原样保留。新checkpoint：`.hermes/tmp/offline-parity-author/continuation-02-checkpoint/manifest.json`，WORKING_NOT_OWNER_GREEN，含12个源码/测试+report完整字节、相对原before/continuation start的diff、当前JSON/log/isolatedclient Web hashes，并保留原JVM evidence。下一轮先比ledger/checkpoint/live SHA，不得重跑任何已应用脚本。'
c='旧before/continuation-start/continuation-02-start/working-checkpoint/continuation-02-checkpoint均原样保留；本轮开始已验证13项live SHA并保存directory-start全字节。最新checkpoint：`.hermes/tmp/offline-parity-author/directory-checkpoint/manifest.json`，WORKING_NOT_OWNER_GREEN，含12 source/test+最终report exact fullbytes、start/original scoped diff、真实当前JSON/log及isolatedclient Web hashes。下一轮先比ledger/checkpoint/live SHA，不重跑已落盘脚本。'
assert text.count(a)==1;text=text.replace(a,c)
a='## Checkpoint / evidence';assert text.count(a)==1
section='''## Directory/Collection bounded continuation — current closure

- 唯一writer本轮只修改offline-api.ts、sync-mutation-plan.ts、offline-author-parity.integration.test.ts及本report；父维护CURRENT/board，本writer已停production/test写。02整体仍WORKING，03未开始，未推进gaps4–7。
- 真实当前10 focused / 1239 default / 704 integration，success=true、failed0、pending0；shared/server/web typecheck、root lint、diff-check全PASS；T3_SW_BUILD=1隔离client Vite249 modules PASS。无部署dist/SW/PWA/APK/手机证明，Vite configLoader/chunk-size/outDir warnings如实保留。
- 新增6测试：actual Directory生命周期/cascade、held Directory、held Collection以及wrong UUID/noncausal seq/unknown scope三个拒结算边界。未重写原两caller、profile-delete、held Entry测试；全文件/全suite仅回归。actual Directory-set version高于Producer delete baseVersion的真实seed通过，未跨kind数字比较。
- directory-red.log为Directory held真业务RED→directory-green-final.log GREEN；directory-local-cascade-red.log为新Directory cold查询残留两作品真业务RED→当前GREEN。新Directory survivor验证最初导致旧Entry-delete Directory/Collection回归失败（directory-integration.json：703pass/1fail），补已验证Entry delete journal+causal seq后按最终membership timeline比较，当前704pass。未重新新增Entry held矩阵。
- 初次actual caller空Directory无卡可移动属于harness路径不适配；改用现有真实双Work拖放create caller，不修改AuthorPage。getViewLater方法名、Directory-set不存在numeric id假设、Entry关系version及Collection position预期、TS/unused-variable错误均保留真实日志，不能冒充业务RED。Directory-set实际schema只有producerId/syncUid/version。
- 普通动作期间记录两个既有navigation-counts读取；断网fetch抛错，Directory/create/move/rename/delete无业务mutation transport。不是零shell请求证明，不扩大成known-offline-read审计。
- trusted ownedScope只由当前verified snapshot写入并绑定完整original fingerprint（含UUID/kind/UID/library/epoch/base/payload）；candidate先验证Producer删除journal/absence/cursor，再验证每个Directory receipt的causal seq及原identity，最后安装verified snapshot+durable ACK后清queue。ACK-loss保留exact原封包，cold重试通过。无可信scope时拒replay/cleanup，不接受任意native receipt JSON；缺失proof更多负向矩阵仍不宣称完整。
- 新native contract/Java/fixture未改，未新跑JVM；历史61/13suite归档不替代新timeline。共享planner的无scope conservative dependency变化只建立foreground及default回归证明，专门production Worker新Author/Directory/Collection timeline仍UNVERIFIED。contract及nativefixture SHA与directory-start完全一致；手机/WebView/Keystore/force-stop仍UNVERIFIED。
- 第一未闭合功能cell仍gap4：actual GalleryApp standalone Author create→direct detail/编辑与新Author后续编辑族；gap1剩余完整negative、gap5restore、gap6connected/capability/snapshot、gap7native原样继承。没有把本组GREEN等同于02 owner GREEN。

'''
text=text.replace(a,section+a,1)
# byte replacement preserves existing newline style; report currently LF.
assert len(text)>len(old);p.write_bytes(text.encode());ledger[report]['current']=sha(p.read_bytes());(STAGE/'ledger.json').write_text(json.dumps(ledger,indent=2))
out=STAGE/'directory-checkpoint';assert not out.exists();out.mkdir();records={}
for name,item in ledger.items():
 raw=(ROOT/name).read_bytes();assert sha(raw)==item['current'],name
 q=out/'source'/name;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(raw);records[name]={**item,'bytes':len(raw)}
 for label,base in [('original',STAGE/'before'/name),('directory-start',STAGE/'directory-start'/name)]:
  if base.exists():
   diff=''.join(difflib.unified_diff(base.read_bytes().decode().splitlines(True),raw.decode().splitlines(True),fromfile=label+'/'+name,tofile='live/'+name));q=out/'diffs'/label/(name+'.diff');q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(diff.encode())
evidence={}
for f in STAGE.glob('directory-*'):
 if f.is_file():
  raw=f.read_bytes();q=out/'evidence'/f.name;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(raw);evidence[f.name]=sha(raw)
web={}
for f in (STAGE/'directory-web-closure').rglob('*'):
 if f.is_file():
  rel=f.relative_to(STAGE/'directory-web-closure');raw=f.read_bytes();q=out/'web'/rel;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(raw);web[str(rel)]=sha(raw)
m={'status':'WORKING_NOT_OWNER_GREEN','source':records,'evidence':evidence,'web':web,'gates':counts,'currentOtherGates':{'typechecks':'PASS shared/server/web','rootLint':'PASS','diffCheck':'PASS','isolatedClientBuild':'PASS 249 modules; no SW/PWA/APK'},'priorCheckpointSha256':sha((STAGE/'continuation-02-checkpoint/manifest.json').read_bytes()),'native':'NOT_RERUN; historical61 does not prove current native timeline','completedBoundedCells':['Directory actual caller lifecycle->delete/cascade','held Directory->independent progress->release/ACK-loss/cold exact retry','held Collection->independent progress->release/ACK-loss/cold retry','wrong UUID/noncausal seq/unknown scope retain originals'],'firstGap':'gap4 actual GalleryApp standalone Author creation and new Author editing families; gaps1negative/5restore/6connected/7native remain','nextOwner03':'NOT_STARTED'}
(out/'manifest.json').write_text(json.dumps(m,indent=2));print('MANIFEST',sha((out/'manifest.json').read_bytes()),'FILES',len(records))
# Exact live/saved/hash equality including final report and archived evidence.
for name,r in records.items():assert sha((ROOT/name).read_bytes())==sha((out/'source'/name).read_bytes())==r['current'],name
for name,h in evidence.items():assert sha((out/'evidence'/name).read_bytes())==h
for name,h in web.items():assert sha((out/'web'/name).read_bytes())==h
print('VERIFIED FINAL live==saved==sha, evidence and Web',counts)
