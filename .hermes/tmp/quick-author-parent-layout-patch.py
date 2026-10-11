from pathlib import Path
import hashlib,json
r=Path('D:/Project/TagTraceTrove');f='apps/web/src/AuthorPage.vue';p=r/f
b=p.read_bytes();assert hashlib.sha256(b).hexdigest()=='cac1cee8f63ba3d88b33295a5c300bc03fe529a8ee472e672d23889ec7a058f8'
q=r/'.hermes/tmp/quick-author-parent-safe/start'/f;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b);assert q.read_bytes()==b
old=b':key="`author-rating-${index}`"\r\n          class="author-list-filter-row"'
if old not in b:old=old.replace(b'\r\n',b'\n')
assert b.count(old)==1
new=old.replace(b'class="author-list-filter-row"',b'class="author-list-filter-row author-list-rating-filter-row"')
updated=b.replace(old,new,1)
old=b'  .author-list-filter-row { max-width: 100%; }'
assert updated.count(old)==1
nl=b'\r\n' if b'\r\n' in b else b'\n'
lines=[b'  /* The actual phone card is narrower than its viewport. Keep the dimension readable',b'     above the operator/stars row instead of pushing delete outside the clipped card. */',b'  .author-list-rating-filter-row {',b'    display: grid;',b'    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) 44px;',b'    width: 100%;',b'    min-width: 0;',b'  }',b'  .author-list-rating-filter-row > label { grid-column: 1 / -1; min-width: 0; }',b'  .author-list-rating-filter-row select { width: 100%; box-sizing: border-box; }',b'  .author-list-rating-filter-row > .remove-tag-filter { grid-column: 3; min-width: 44px; }',b'  /* With Unrated, only the operator remains: let it use both select tracks. */',b'  .author-list-rating-filter-row > select:nth-child(2):nth-last-child(2) { grid-column: 1 / span 2; }']
updated=updated.replace(old,old+nl+nl.join(lines),1)
assert p.read_bytes()==b;p.write_bytes(updated)
assert p.read_bytes()==updated
ledger={f:{'beforeSha256':hashlib.sha256(b).hexdigest(),'sha256':hashlib.sha256(updated).hexdigest(),'bytes':len(updated),'scope':'actual-shell360 browser-observed RED targeted responsive fix'}}
(r/'.hermes/tmp/quick-author-parent-safe/working.json').write_text(json.dumps(ledger,indent=2))
print(json.dumps(ledger))
