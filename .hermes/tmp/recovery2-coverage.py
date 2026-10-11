import json,re,difflib,hashlib
from pathlib import Path
R=Path('D:/Project/TagTraceTrove/.hermes/tmp');p=R/'recovery2-snapshot-candidate.ts';s=p.read_text();ls=s.splitlines();C=json.loads((R/'recovery-candidates.json').read_text());covered=set(range(1,1930));evidence=[]
for id,sid,start,end,text in C:
 if id<129500 or id>130253:continue
 rows=[(int(n),l.rstrip('\r').replace('SyncReplayOperation','SyncReplayRequest').replace('return syncReplayOperationSchema.parse(wireFields(operation));','return syncReplayRequestSchema.parse(wireFields(operation));')) for n,l in re.findall(r'^(\d+)\|(.*)$',text,re.M)]
 runs=[]
 for n,l in rows:
  if not runs or n!=runs[-1][-1][0]+1:runs.append([])
  runs[-1].append((n,l))
 for run in runs:
  a=[l for n,l in run]
  for block in difflib.SequenceMatcher(None,a,ls,autojunk=False).get_matching_blocks():
   if block.size<8:continue
   seg='\n'.join(a[block.a:block.a+block.size])
   if s.count(seg)!=1:continue
   span=[block.b+1,block.b+block.size];covered.update(range(span[0],span[1]+1));evidence.append({'message':id,'snapshot':[run[block.a][0],run[block.a+block.size-1][0]],'candidate':span})
un=[]
for i in range(1930,len(ls)+1):
 if i in covered:continue
 if un and un[-1][1]==i-1:un[-1][1]=i
 else:un.append([i,i])
report={'candidate':str(p),'line_count':len(ls),'normalized_lf_sha256':hashlib.sha256(s.encode()).hexdigest(),'prefix_exact':ls[:1929]==(R/'offline-api-truncated-preserved.ts').read_text().splitlines(),'actual_missing_text_not_invented':True,'latest_read_uncovered_candidate_ranges':un,'latest_read_evidence':evidence,'known_unresolved':{'assignEntryTag':[4499,4520],'diagnostic':'TS2322: reconstructed historical assignEntryTag still returns Promise<void>; current GalleryApi expects assigned Tag DTO|null. No actual replacement body located. Do not fabricate return logic.','unanchored_snapshot_original_ranges':[[129794,4865,4910],[130047,4340,4380],[130062,4320,4385]]},'invariants':{k:s.count(k) for k in ['async function enqueueGalleryOrder','async setGalleryOrder','async getClientId','store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY','const stagedObjectUrls']},'limitations':['Suffix has real older baseline + history changes, but ranges not in latest-read coverage are NOT independently proven equal to final pre-truncation source.','No production file writes and no database/assets writes.','TypeScript virtual-host check against existing project: no syntax errors; one candidate-file TS2322. No runtime/gate claim.']}
(R/'recovery2-coverage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps({k:v for k,v in report.items() if k!='latest_read_evidence'},ensure_ascii=False,indent=2))
