from pathlib import Path
import hashlib,json
R=Path('D:/Project/TagTraceTrove'); S=R/'.hermes/tmp/offline-parity-author'; sha=lambda b:hashlib.sha256(b).hexdigest()
m=S/'directory-checkpoint/manifest.json';assert sha(m.read_bytes())=='13bdf0d6d7c9e6763fd0e4ddc926a40c2a6a67e4fc5d7d279f922c2434e2537a'
manifest=json.loads(m.read_bytes());ledger=json.loads((S/'ledger.json').read_bytes());out=S/'gap4-start';assert not out.exists();out.mkdir()
for p,v in manifest['source'].items():
 b=(R/p).read_bytes();assert sha(b)==v['current']==ledger[p]['current'],p
 q=out/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
p='apps/web/src/GalleryApp.vue';b=(R/p).read_bytes();q=out/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b);manifest['source'][p]={'current':sha(b),'bytes':len(b)}
(out/'manifest.json').write_text(json.dumps(manifest['source'],indent=2));print('START verified 13 saved + GalleryApp',sha((out/'manifest.json').read_bytes()))
for p,terms in [('apps/web/src/GalleryApp.vue',['createAuthor','openAddAuthor','AddAuthorPage']),('apps/web/src/offline/offline-api.ts',['enqueueProducer','enqueueAuthor','sourceOrigin','producer.create']),('apps/web/src/AuthorPage.vue',['name="','data-testid=','assignAuthorTag'])]:
 lines=(R/p).read_text().splitlines();print('\nFILE',p)
 for i,line in enumerate(lines):
  if any(t in line for t in terms): print(str(i+1)+': '+line)
