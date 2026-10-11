import { randomUUID } from 'node:crypto';
import type { SyncSnapshot, SyncDeltaRequest, SyncDeltaPage } from '@t3/shared';
import { syncDeltaRequestSchema } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { buildSyncSnapshot, getSyncIdentity, SyncFeedConflict } from './sync-service.js';

const MAX_BYTES = 48 * 1024 * 1024;
const MAX_ITEMS = 16;
const TTL = 5 * 60 * 1000;
interface Baseline { snapshot: SyncSnapshot; media: 'none' | 'thumbnails'; text: string; expires: number }
interface Session { request: string; page: Omit<SyncDeltaPage, 'offset' | 'chunk' | 'done'>; insert: string; served: number; expires: number }
interface Cache { bases: Map<string, Baseline>; sessions: Map<string, Session> }
const caches = new WeakMap<T3Database, Cache>();
function cacheFor(db: T3Database): Cache {
  let cache = caches.get(db);
  if (!cache) { cache = {bases:new Map(),sessions:new Map()}; caches.set(db,cache); }
  for (const [key,row] of cache.bases) if (row.expires <= Date.now()) cache.bases.delete(key);
  for (const [key,row] of cache.sessions) if (row.expires <= Date.now()) cache.sessions.delete(key);
  return cache;
}
function bound(cache: Cache) {
  while (cache.bases.size + cache.sessions.size > MAX_ITEMS
    || [...cache.bases.values()].reduce((n,row)=>n+Buffer.byteLength(row.text),0)
      + [...cache.sessions.values()].reduce((n,row)=>n+Buffer.byteLength(row.insert),0) > MAX_BYTES) {
    const base = cache.bases.keys().next().value;
    if (base !== undefined) cache.bases.delete(base);
    else { const session = cache.sessions.keys().next().value; if (session === undefined) break; cache.sessions.delete(session); }
  }
}
export function rememberSnapshot(db:T3Database,snapshot:SyncSnapshot,media:'none'|'thumbnails') {
  const cache=cacheFor(db); const text=JSON.stringify(snapshot);
  if (Buffer.byteLength(text)>MAX_BYTES) return;
  cache.bases.set(snapshot.header.checksum,{snapshot,media,text,expires:Date.now()+TTL}); bound(cache);
}
export function readSnapshotDelta(db:T3Database,raw:SyncDeltaRequest):SyncDeltaPage {
  const input=syncDeltaRequestSchema.parse(raw);
  const identity=getSyncIdentity(db);
  if (input.libraryId!==identity.libraryId || input.syncEpoch!==identity.syncEpoch) throw new SyncFeedConflict('Delta identity mismatch');
  const cache=cacheFor(db);
  const {token,offset,...scope}=input; const request=JSON.stringify(scope);
  let session=token ? cache.sessions.get(token):undefined;
  if (token && (!session || session.request!==request)) throw new SyncFeedConflict('Delta session unavailable; fetch full snapshot');
  if (!token) {
    if (offset!==0) throw new SyncFeedConflict('Delta must start at zero');
    const base=cache.bases.get(input.baseChecksum);
    if (!base || base.media!==input.media || base.snapshot.header.libraryId!==input.libraryId
      || base.snapshot.header.syncEpoch!==input.syncEpoch || base.snapshot.header.changeSeq!==input.baseChangeSeq) {
      throw new SyncFeedConflict('Verified baseline unavailable; fetch full snapshot');
    }
    const target=buildSyncSnapshot(db,{media:input.media}); const text=JSON.stringify(target);
    let prefix=0; while (prefix<base.text.length && prefix<text.length && base.text[prefix]===text[prefix]) prefix++;
    let suffix=0; while (suffix<base.text.length-prefix && suffix<text.length-prefix
      && base.text[base.text.length-1-suffix]===text[text.length-1-suffix]) suffix++;
    const insert=text.slice(prefix,text.length-suffix);
    if (Buffer.byteLength(insert)>MAX_BYTES) throw new SyncFeedConflict('Delta exceeds bound; fetch full snapshot');
    const id=randomUUID();
    session={request,page:{version:1,token:id,baseChecksum:input.baseChecksum,target:target.header,
      prefix,remove:base.text.length-prefix-suffix,insertLength:insert.length},insert,served:0,expires:Date.now()+TTL};
    rememberSnapshot(db,target,input.media); cache.sessions.set(id,session); bound(cache);
    if (!cache.sessions.has(id)) throw new SyncFeedConflict('Delta cache exhausted');
  }
  if (!session || offset>session.served || offset>session.insert.length) throw new SyncFeedConflict('Unserved delta offset');
  const chunk=session.insert.slice(offset,offset+16384); const next=offset+chunk.length; const done=next===session.insert.length;
  session.served=Math.max(session.served,next);
  if (done) {
    // Only a fully served immutable target grants existing ack permission.
    db.prepare(`INSERT INTO sync_feed_cursors(library_id,sync_epoch,client_id,served_seq)
      VALUES(?,?,?,?) ON CONFLICT(library_id,sync_epoch,client_id) DO UPDATE SET served_seq=MAX(served_seq,excluded.served_seq)`)
      .run(input.libraryId,input.syncEpoch,input.clientId,session.page.target.changeSeq!);
  }
  return {...session.page,offset,chunk,done};
}
