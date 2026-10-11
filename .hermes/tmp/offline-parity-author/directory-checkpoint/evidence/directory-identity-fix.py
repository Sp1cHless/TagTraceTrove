from guard import ROOT,STAGE,sha
import json
p='apps/web/src/offline/offline-api.ts';ledger=json.loads((STAGE/'ledger.json').read_text());raw=(ROOT/p).read_bytes();assert sha(raw)==ledger[p]['current']
edits=[('{producerUid:string;producerId:number;setId:number}','{producerUid:string;producerId:number}',2),('producerId:producer.id,setId:set.id','producerId:producer.id',1),(' && Number.isSafeInteger(value.scope.setId) && value.scope.setId > 0','',1),('set.id !== scope.setId || ','',1)]
for a,b,n in edits:
 assert raw.count(a.encode())==n,(a,raw.count(a.encode()));raw=raw.replace(a.encode(),b.encode())
(ROOT/p).write_bytes(raw);ledger[p]['current']=sha(raw);(STAGE/'ledger.json').write_text(json.dumps(ledger,indent=2))
