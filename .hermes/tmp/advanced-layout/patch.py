from pathlib import Path
import hashlib,json
root=Path('D:/Project/TagTraceTrove'); folder=root/'.hermes/tmp/advanced-layout'; manifest=[]
def edit(name,changes):
 p=root/name; original=p.read_bytes(); sha=hashlib.sha256(original).hexdigest(); backup=folder/'before'/name;backup.parent.mkdir(parents=True,exist_ok=True);backup.write_bytes(original); candidate=original
 for old,new in changes:
  old=old.replace('\n','\r\n').encode() if b'\r\n' in original else old.encode();new=new.replace('\n','\r\n').encode() if b'\r\n' in original else new.encode();assert candidate.count(old)==1,(name,old);candidate=candidate.replace(old,new)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==sha;assert len(candidate)>=len(original);p.write_bytes(candidate);manifest.append({'path':name,'before':sha,'after':hashlib.sha256(candidate).hexdigest()})
edit('apps/web/src/AdvancedEditingPage.vue',[
('.advanced-page { display: grid; gap: 1.25rem; }','.advanced-page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.25rem; container-type: inline-size; }'),
('  gap: 1rem;\n  padding: 1.25rem;','  gap: 1rem;\n  grid-template-columns: minmax(0, 1fr);\n  overflow-wrap: anywhere;\n  padding: 1.25rem;'),
('.advanced-card h3 { margin: 0; }','''/* Intrinsic file/input widths must not enlarge the actual shell card. */
.advanced-card > *, .alias-form > *, .tag-merge-panel > * { min-width: 0; }
.advanced-card button, .advanced-card input, .advanced-card select { max-width: 100%; min-width: 0; box-sizing: border-box; }
.dictionary-import label { min-width: 0; max-width: 100%; }
.tag-merge-row > * { min-width: 0; max-width: 100%; }
.tag-merge-row :deep(.suggestion-input input) { min-width: 0; max-width: 100%; box-sizing: border-box; }
.author-alias-chip { overflow-wrap: anywhere; }
.advanced-card h3 { margin: 0; }'''),
('@media (min-width: 34rem) {','@container (min-width: 44rem) {'),
('.alias-name { overflow-wrap: anywhere; }','.alias-name { overflow-wrap: anywhere; }'),
('.taxonomy-alias-list li {\n  display: grid;','.taxonomy-alias-list li {\n  min-width: 0;\n  overflow-wrap: anywhere;\n  display: grid;')])
edit('apps/web/src/SourceMaintenancePanel.vue',[
('.sm-origin, .sm-target, .sm-job, .sm-review, .sm-commit { margin-top: 0.8rem; }','''/* Break URL/name min-content at the card, rather than clipping the shell. */
.advanced-card { min-width: 0; overflow-wrap: anywhere; }
.advanced-card > *, .sm-source-list label > *, .sm-inline > * { min-width: 0; max-width: 100%; }
.advanced-card button, .advanced-card input { box-sizing: border-box; min-width: 0; max-width: 100%; }
.sm-inline input[type='text'] { flex: 1 1 10rem; }
.sm-origin, .sm-target, .sm-job, .sm-review, .sm-commit { margin-top: 0.8rem; }'''),
('.sm-inline { display: inline-flex; align-items: center; gap: 0.4rem; }','.sm-inline { display: inline-flex; flex-wrap: wrap; max-width: 100%; align-items: center; gap: 0.4rem; }')])
edit('apps/web/src/components/OfflineLibrarySettings.vue',[
('  display: grid;\n  gap: 0.55rem;','  display: grid;\n  grid-template-columns: minmax(0, 1fr);\n  min-width: 0;\n  overflow-wrap: anywhere;\n  gap: 0.55rem;'),
('.offline-settings p,','''/* Labels, file inputs and native status must fit the enclosing Advanced card. */
.offline-settings > *, .offline-settings section > * { min-width: 0; max-width: 100%; }
.offline-settings label { display: grid; gap: 0.35rem; }
.offline-settings input, .offline-settings select, .offline-settings textarea, .offline-settings button { min-width: 0; max-width: 100%; box-sizing: border-box; }
.offline-settings textarea { width: 100%; }
.offline-settings p,''')])
(folder/'patch-manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest,indent=2))
