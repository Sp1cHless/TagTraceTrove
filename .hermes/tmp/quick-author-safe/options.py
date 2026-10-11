from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[3]
base=root/'.hermes/tmp/quick-author-safe'
manifest=base/'working.json'
def patch(path,old,new):
 p=root/path;b=p.read_bytes();m=json.loads(manifest.read_text())
 assert hashlib.sha256(b).hexdigest()==m[path],f'external drift {path}'
 old=old.encode();new=new.encode()
 if b.count(old)!=1:
  old=old.replace(b'\n',b'\r\n');new=new.replace(b'\n',b'\r\n')
 assert b.count(old)==1,(path,b.count(old))
 p.write_bytes(b.replace(old,new,1));m[path]=hashlib.sha256(p.read_bytes()).hexdigest();manifest.write_text(json.dumps(m,indent=2))
patch('apps/web/src/offline/offline-library.ts', '''    const visibleEntryIds = new Set(payload.entries.filter((entry) => (
      (entryType === undefined || entry.type === entryType)
      && (includeNsfw || !(galleryNsfw.get(entry.type) ?? false))
    )).map((entry) => entry.id));
    const visibleProducerIds = new Set(payload.entryProducers
      .filter((row) => visibleEntryIds.has(row.entryId)).map((row) => row.producerId));''', '''    const eligibleAuthors = listAuthors().filter((author) => (
      (includeNsfw || !author.nsfw)
      && (entryType === undefined || author.galleryType === entryType)
    ));
    const visibleProducerIds = new Set(eligibleAuthors.map((author) => author.id));
    const galleryTypes = new Set(eligibleAuthors.map((author) => author.galleryType));
    const visibleEntryIds = new Set(payload.entryProducers
      .filter((row) => visibleProducerIds.has(row.producerId)).map((row) => row.entryId));''')
patch('apps/web/src/offline/offline-library.ts', '''      // Nothing to filter Authors by yet: the offline snapshot carries no Author rating dimensions,
      // and guessing at the online ones would offer filters this copy cannot answer.
      ratingSlots: payload.ratingSlots.filter(slot => slot.subjectKind === 'author_self'
        && payload.producerRatingValues.some(row => row.slotId === slot.id && row.stars !== null && visibleProducerIds.has(row.producerId)))''', '''      // New unscored dimensions are useful too: `unrated` finds their Authors.
      ratingSlots: payload.ratingSlots.filter(slot => slot.subjectKind === 'author_self'
        && galleryTypes.has(slot.entryType))''')
