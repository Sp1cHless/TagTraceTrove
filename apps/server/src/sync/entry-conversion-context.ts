import { syncEntryConversionContextSchema, type SyncEntryConversionContext } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { getSyncIdentity } from './sync-service.js';
/** One read transaction; each collection uses limit+1 and rejects rather than truncating. */
export function entryConversionContext(db:T3Database,id:number):SyncEntryConversionContext {
 return db.transaction(()=>{
  const entry=db.prepare('SELECT id,sync_uid AS syncUid,sync_version AS syncVersion FROM entries WHERE id=?').get(id);
  if(!entry)throw new Error('Entry unavailable');
  const current=db.prepare(`SELECT p.id,p.sync_uid AS producerUid,p.name,p.sync_version AS version FROM entry_producers ep JOIN producers p ON p.id=ep.producer_id WHERE ep.entry_id=? ORDER BY p.id LIMIT 201`).all(id) as Array<{id:number;producerUid:string;name:string;version:number}>;
  if(current.length>200)throw new Error('Conversion Author context limit exceeded');
  const authors=current.map(owner=>({...owner,workUids:db.prepare('SELECT e.sync_uid FROM entry_producers ep JOIN entries e ON e.id=ep.entry_id WHERE ep.producer_id=? ORDER BY e.sync_uid LIMIT 2001').pluck().all(owner.id)}));
  if(authors.some(owner=>owner.workUids.length>2000))throw new Error('Conversion work context limit exceeded');
  const target=db.prepare("SELECT id,sync_uid AS producerUid,sync_version AS version FROM producers WHERE name='multiple author' COLLATE NOCASE ORDER BY id LIMIT 1").get()??null;
  const directories=db.prepare(`SELECT ds.sync_uid AS entityUid,ds.sync_version AS version FROM author_directory_sets ds JOIN entry_producers ep ON ep.producer_id=ds.producer_id WHERE ep.entry_id=? ORDER BY ds.sync_uid LIMIT 2001`).all(id) as Array<{entityUid:string;version:number}>;
  const collections=db.prepare(`SELECT DISTINCT c.sync_uid AS entityUid,c.sync_version AS version FROM collections c JOIN collection_producers cp ON cp.collection_id=c.id JOIN entry_producers ep ON ep.producer_id=cp.producer_id WHERE ep.entry_id=? ORDER BY c.sync_uid LIMIT 2001`).all(id) as Array<{entityUid:string;version:number}>;
  if(directories.length+collections.length>2000)throw new Error('Conversion cascade context limit exceeded');
  return syncEntryConversionContextSchema.parse({...getSyncIdentity(db),entry,authors,target,cascadeOwners:[...directories.map(row=>({...row,entityKind:'author_directory_set'})),...collections.map(row=>({...row,entityKind:'collection'}))]});
 })();
}
