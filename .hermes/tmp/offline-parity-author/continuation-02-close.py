from guard import edit,ROOT,STAGE,sha
import json,difflib
p='.hermes/artifacts/offline-parity-author-implementation.md'
edit(p,'本接续唯一 production/test writer 已停写。02未完整闭合，03未开始；不要把当前全部测试通过等同于有限要求全部覆盖。不存在审批/权限阻断；这次按预留收束预算完成验证与完整字节checkpoint，剩余gap需要接续源码/测试工作。','本轮接续唯一 production/test writer 已停写。02仍未完整闭合，03未开始；不要把当前全部测试通过等同于有限要求全部覆盖。不存在审批/权限阻断；预算预留收束，剩余gap需要下一轮继续源码/测试。此次先逐一验证原12项live SHA并保存continuation-02-start完整字节，未覆盖before/continuation-start/旧working-checkpoint。')
edit(p,'## Current gates (same source boundary)','## Prior checkpoint gates (historical; current continuation gates below)')
edit(p,'1. **混合Producer edit→delete authoritative settlement未闭合**：当前profiles/anchors/self-rating validators仍要求surviving producer。需要实际RED，按matching original receipts+同owner causal seq/version+verified delete authority授权前驱；不能无条件absence跳过验证。','1. **混合Producer edit→delete有限正向已修复，负向矩阵仍缺**：新实际业务RED `continuation-02-red-actual.log`证明7个queued rows虽SQL删除却无法cleanup；新增逐original applied receipt、same Producer UID/library/epoch、applied order、serverSeq与同owner version早于已验证delete检查，profiles/anchors/ratings按此结算。profile/anchor/tag/rating/ViewLater→delete真实SQL+ACK-loss retry GREEN；第一次setProducerViewLater不存在是harness错误。receipt允许省略entityId，若有则严格检查；原snapshot有该UID时也核对ID，ACK-loss后的新snapshot已absence时仍以exact UUID receipt+原UID+verified delete因果授权。尚未新增伪receipt/wrong/missing tombstone等负向矩阵，不能称严格安全矩阵完整。')
edit(p,'2. **跨owner causal held-dependency未闭合**：producer.delete计划未显式等待引用本Author的Entry Authors、Collection membership、owned Directory-set retained/held先行操作。当前referencedEntityKeys/mutationQueuePlan缺少完整producer reference映射；先actual held row RED，独立owner应继续；跨owner只比较各自身份/seq因果，不能直接比较不同owner版本数。','2. **FIRST GAP：owned Directory-set独立owner映射/因果settlement仍未闭合**。新增held Entry Author实际业务RED：SQL作者被提前删除；现entry.authors.set映射base与desired Producer UIDs、create-and-link映射base+new Producer UID，producer.delete reverse-reference predecessor加入真正mutationQueuePlan。held引用Entry挡删除、独立Entry推进、恢复held后清空GREEN。Collection现有producer reference因此也被reverse graph纳入，但未新写Collection held实际测试，不能称该cell通过。author.directories.set封包只有directory arrays，author_directory_set UID需可信snapshot.authorDirectorySets→Producer UID映射，不可猜UID或跨owner直接比较version。目录receipt被后续delete消失的因果settlement仍缺，下一轮先补此真实RED。')
edit(p,'当前checkpoint将保存为 `.hermes/tmp/offline-parity-author/working-checkpoint/manifest.json`（WORKING，非GREEN），包括11个源码/测试全字节、report、scoped diff、真实JSON/JVM XML/generated Java/Web-build hashes。原before与continuation-start完整字节保留；续接先ledger SHA匹配后定向patch，不得回滚original或重复已有脚本。','旧working-checkpoint原样保留。新checkpoint：`.hermes/tmp/offline-parity-author/continuation-02-checkpoint/manifest.json`，WORKING_NOT_OWNER_GREEN，含12个源码/测试+report完整字节、相对原before/continuation start的diff、当前JSON/log/isolatedclient Web hashes，并保留原JVM evidence。下一轮先比ledger/checkpoint/live SHA，不得重跑任何已应用脚本。')
edit(p,'## Checkpoint / evidence','''## Continuation-02 current execution boundary

- 此次production/test只修改offline-api.ts、sync-mutation-plan.ts、offline-author-parity.integration.test.ts；其余原11项来源hash验证未漂移。sync-mutation-plan.ts首次纳入ledger，以当前既有dirty完整bytes保存before，未用HEAD。
- 实际4 focused / 1239 default / 698 integration：success true、failed0、pending0；shared/server/web typecheck、root lint、diff-check PASS。git有既有line-ending提示；isolatedclient Vite249 modules PASS，有configLoader/chunk-size warning，无SW/PWA/deploydist/APK证明。
- 原两条caller未重写，本轮全文件回归PASS。mixed edits及held Entry各为真实业务RED→GREEN；未实现/未新增证明cells仍在上列1–7。全部现有测试PASS不授权02 GREEN。
- 本轮未改Java/shared nativecontract/allkindfixture，未新跑JVM。contract SHA `7d7ac661718a0656b653f7390d2eb53a7ee781951f58195212e5859670a3895e`、fixture SHA `20f620d5dae5af2214a38445830020ac773b521e409f5ce0977548687863b875`与原checkpoint相同；原generated Java归档SHA `c7792a74088c05371d7725d4cdeed9e47eab21514a2f7b920ba993149a44d8b9`匹配。原13suite61 JVM为历史执行；新foreground graph输入变化不等于专门native timeline已覆盖，不宣称新61或完整Java source hash等价证明。手机仍UNVERIFIED。

## Checkpoint / evidence''')
# Freeze only after final report bytes. Original baselines and old checkpoint remain immutable.
out=STAGE/'continuation-02-checkpoint'; assert not out.exists(); out.mkdir()
ledger=json.loads((STAGE/'ledger.json').read_text()); records={}
for name,item in ledger.items():
 b=(ROOT/name).read_bytes(); assert sha(b)==item['current'],name
 q=out/'source'/name;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
 records[name]={**item,'bytes':len(b)}
 for label,base in [('original',STAGE/'before'/name),('continuation',STAGE/'continuation-02-start'/name)]:
  if base.exists():
   d=''.join(difflib.unified_diff(base.read_bytes().decode('utf-8').splitlines(True),b.decode('utf-8').splitlines(True),fromfile=label+'/'+name,tofile='live/'+name))
   target=out/'diffs'/label/(name+'.diff');target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(d.encode())
evidence={}
for f in STAGE.glob('continuation-02-*'):
 if f.is_file():
  b=f.read_bytes();q=out/'evidence'/f.name;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b);evidence[f.name]=sha(b)
web={}
for f in (STAGE/'continuation-02-web').rglob('*'):
 if f.is_file():
  rel=f.relative_to(STAGE/'continuation-02-web');b=f.read_bytes();q=out/'web'/rel;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b);web[str(rel)]=sha(b)
m={'status':'WORKING_NOT_OWNER_GREEN','source':records,'evidence':evidence,'web':web,'priorCheckpointSha256':sha((STAGE/'working-checkpoint/manifest.json').read_bytes()),'priorJvm':'historical archived 61; not rerun, native timeline remains unproved','firstGap':'Directory-set independent identity mapping and delete-causal receipt settlement; Collection held cell not exercised','nextOwner03':'NOT_STARTED'}
(out/'manifest.json').write_text(json.dumps(m,indent=2));print('checkpoint',len(records),'source/report',sha((out/'manifest.json').read_bytes()))
