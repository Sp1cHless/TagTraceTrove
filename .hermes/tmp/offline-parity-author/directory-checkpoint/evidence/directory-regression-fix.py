from guard import ROOT,STAGE,sha
import json
edits=[]
def add(p,a,b):edits.append((p,a,b))
p='apps/web/src/offline/offline-api.ts'
add(p,"              if (!set || set.producerId !== scope.producerId || set.syncVersion < receipt.resourceVersion\n                || (!later && JSON.stringify(producerDirectoriesFromSnapshot(snapshot,scope.producerId)) !== JSON.stringify(operation.payload.directories))) throw new Error('Snapshot refresh failed: Directory final owner/value is missing');", """              const desired = operation.payload.directories.map(directory => ({...directory,entries:directory.entries.filter(entry => {
                const deleted = entryDeleteReceipts.get(entry.syncUid);
                if (!deleted) return true;
                const last = appliedOperations.findIndex(row => row.operationKind === 'entry.delete' && row.entityUid === entry.syncUid);
                if (appliedOperations.indexOf(operation) >= last || receipt.serverSeq >= deleted.serverSeq) throw new Error('Entry deletion cannot settle a noncausal Directory membership');
                return false;
              })}));
              if (!set || set.producerId !== scope.producerId || set.syncVersion < receipt.resourceVersion
                || (!later && JSON.stringify(producerDirectoriesFromSnapshot(snapshot,scope.producerId)) !== JSON.stringify(desired))) throw new Error('Snapshot refresh failed: Directory final owner/value is missing');""")
p='apps/web/tests/offline-author-parity.integration.test.ts'
add(p,'({syncVersion,updatedAt,...row})=>row','({syncVersion,updatedAt,...row})=>{void syncVersion;void updatedAt;return row;}')
add(p,'({position,...row})=>row','({position,...row})=>{void position;return row;}')
# all bounded anchors in sequential simulated buffers, matching explicit occurrence counts
ledger=json.loads((STAGE/'ledger.json').read_text());buffers={}
for p,a,b in edits:
 raw=buffers.get(p,(ROOT/p).read_bytes());assert sha((ROOT/p).read_bytes())==ledger[p]['current']
 n=2 if p.endswith('test.ts') else 1;matches=[(a.encode().replace(b'\n',nl),b.encode().replace(b'\n',nl)) for nl in [b'\n',b'\r\n'] if raw.count(a.encode().replace(b'\n',nl))==n];assert matches,(p,a);x,y=matches[0];buffers[p]=raw.replace(x,y)
for p,b in buffers.items(): (ROOT/p).write_bytes(b);ledger[p]['current']=sha(b)
(STAGE/'ledger.json').write_text(json.dumps(ledger,indent=2))
