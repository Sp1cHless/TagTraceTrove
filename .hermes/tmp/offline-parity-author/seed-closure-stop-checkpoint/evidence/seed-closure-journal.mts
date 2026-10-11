import {createMigratedMemoryDatabase} from '../../..//apps/server/src/database/testing.js';
import {createProducer,linkEntryProducer} from '../../../apps/server/src/repositories/producer-repository.js';
import {createEntry} from '../../../apps/server/src/repositories/entry-repository.js';
import {createEntryContent} from '../../../apps/server/src/repositories/entry-content-repository.js';
import {setGalleryPartition} from '../../../apps/server/src/repositories/partition-repository.js';
const db=createMigratedMemoryDatabase();try{
const author=createProducer(db,{name:'Hypergryph'});const entry=createEntry(db,{title:'Endfield',type:'game'});linkEntryProducer(db,entry.id,author.id);createEntryContent(db,{entryId:entry.id,contentType:'Source URL',content:'https://hitomi.la/g/1.html',sortOrder:0});setGalleryPartition(db,'game',true);db.prepare('UPDATE entries SET cover_ref=?,preview_ref=?,preview_refs=? WHERE id=?').run('assets/game/endfield/cover.jpg','assets/game/endfield/preview.jpg',JSON.stringify(['assets/game/endfield/page-1.jpg','assets/game/endfield/page-2.jpg']),entry.id);
console.log(JSON.stringify(db.prepare('SELECT seq,entity_kind,change_kind,resource_version,record_json FROM sync_changes ORDER BY seq').all(),null,2));
}finally{db.close();}
