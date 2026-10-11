import { syncCollectionIdentitySchema, type SyncCollectionIdentity } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { getSyncIdentity } from './sync-service.js';
export function collectionDeleteIdentity(database:T3Database,id:number):SyncCollectionIdentity|undefined {
  const owner=database.prepare(`SELECT id,sync_uid AS syncUid,sync_version AS syncVersion,kind,parent_id AS parentId FROM collections WHERE id=?`).get(id) as {id:number;syncUid:string;syncVersion:number;kind:string;parentId:number|null}|undefined;
  if (!owner) return undefined;
  const parentUid=owner.parentId===null?null:database.prepare('SELECT sync_uid FROM collections WHERE id=?').pluck().get(owner.parentId);
  // Never truncate a destructive scope: >200 is unavailable, not a partial cascade.
  const children=database.prepare('SELECT sync_uid AS syncUid,sync_version AS syncVersion FROM collections WHERE parent_id=? ORDER BY sync_uid COLLATE NOCASE LIMIT 201').all(id);
  return syncCollectionIdentitySchema.parse({...getSyncIdentity(database),id:owner.id,syncUid:owner.syncUid,syncVersion:owner.syncVersion,scope:{kind:owner.kind,parentUid,children}});
}
