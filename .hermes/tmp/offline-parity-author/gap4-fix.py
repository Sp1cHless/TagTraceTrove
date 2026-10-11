from guard import ROOT,STAGE,edit,sha
import json
# Entire batch preflight against exact full bytes, then guarded anchor writes.
batch=[('apps/web/tests/offline-author-parity.integration.test.ts',"  const add=wrapper.findAll('button').find(row=>row.text()==='Add Author');expect(add).toBeDefined();await add!.trigger('click');await settle();", "  expect(wrapper.find('[data-testid=\"new-author\"]').exists()).toBe(true);await wrapper.get('[data-testid=\"new-author\"]').trigger('click');await settle();"),('apps/web/src/GalleryApp.vue',"            {{ t('entry.new') }}\n          </button>","            {{ t('entry.new') }}\n          </button>\n          <button class=\"primary-button\" type=\"button\" data-testid=\"new-author\" @click=\"openCreation('author')\">\n            {{ t('author.new') }}\n          </button>")]
# Cold original identity only includes causally local unsealed creates, not prior updates (avoids double revision advances).
for func,arg in [('enqueueProducerViewLater','producerId'),('enqueueProducerRating','producerId'),('enqueueProducerTags','authorId')]:
 p='apps/web/src/offline/offline-api.ts';text=(ROOT/p).read_text();a=text.index('  async function '+func+'(');b=text.index('\n  async function ',a+5);scope=text[a:b]
 old=f'    const original = active?.snapshot.payload.producers.find((producer) => producer.id === {arg});'
 new=f"    const localCreates = (await store.list()).filter(row => row.operationKind === 'producer.create' && row.clientId === clientId && row.libraryId === active?.snapshot.header.libraryId && row.syncEpoch === active?.snapshot.header.syncEpoch);\n    const original = active === null ? undefined : snapshotWithOverlays(active.snapshot, localCreates).payload.producers.find((producer) => producer.id === {arg});"
 assert scope.count(old)==1
 batch.append((p,scope,scope.replace(old,new)))
# Run UI fix first, then cold identity only after observed actual tag RED.
import sys
batch=[row for row in batch if row[0] != 'apps/web/tests/offline-author-parity.integration.test.ts']
batch=[row for row in batch if (row[0]=='apps/web/src/GalleryApp.vue') == ('--ui' in sys.argv)]
# Dry-run all anchors, preserving each actual newline encoding.
ledger=json.loads((STAGE/'ledger.json').read_bytes());buffers={}
for p,old,new in batch:
 if p not in buffers:
  buffers[p]=(ROOT/p).read_bytes();assert sha(buffers[p])==ledger.get(p,{}).get('current',sha(buffers[p])),p
 b=buffers[p];pairs=[(old.encode().replace(b'\n',nl),new.encode().replace(b'\n',nl)) for nl in [b'\n',b'\r\n']];valid=[(x,y) for x,y in pairs if b.count(x)==1];assert valid,p; x,y=valid[0];buffers[p]=b.replace(x,y,1)
for p,old,new in batch:edit(p,old,new)
