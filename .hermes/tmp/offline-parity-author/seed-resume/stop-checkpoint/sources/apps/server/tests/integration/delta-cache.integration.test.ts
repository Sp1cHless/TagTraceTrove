import { expect, it, vi } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { ackSyncChanges, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { readSnapshotDelta, rememberSnapshot } from '../../src/sync/snapshot-delta.js';
import type { SyncDeltaRequest } from '@t3/shared';

it('rejects changed session scope and expires sessions at the exact deadline', () => {
  const db=createMigratedMemoryDatabase();
  try {
    const entry=createEntry(db,{title:'Base',type:'game'});
    const base=buildSyncSnapshot(db); rememberSnapshot(db,base,'none');
    db.prepare('UPDATE entries SET title=? WHERE id=?').run('x'.repeat(40000),entry.id);
    const request:SyncDeltaRequest={libraryId:base.header.libraryId,syncEpoch:base.header.syncEpoch,protocolVersion:1,clientId:'session-only',media:'none',baseChecksum:base.header.checksum,baseChangeSeq:base.header.changeSeq!,offset:0};
    const now=Date.now(); vi.spyOn(Date,'now').mockReturnValue(now);
    const first=readSnapshotDelta(db,request);
    for (const changed of [{syncEpoch:'unknown'},{protocolVersion:2},{baseChecksum:'unknown'},{media:'thumbnails'},{baseChangeSeq:request.baseChangeSeq+1},{clientId:'other'}]) {
      expect(()=>readSnapshotDelta(db,{...request,token:first.token,offset:first.chunk.length,...changed} as SyncDeltaRequest)).toThrow();
    }
    expect(()=>ackSyncChanges(db,{libraryId:request.libraryId,syncEpoch:request.syncEpoch,protocolVersion:1,clientId:request.clientId,cursorSeq:first.target.changeSeq!})).toThrow();
    vi.spyOn(Date,'now').mockReturnValue(now+300000);
    expect(()=>readSnapshotDelta(db,{...request,token:first.token,offset:first.chunk.length})).toThrow(/session unavailable/i);
  } finally {vi.restoreAllMocks();db.close();}
});

it('evicts old sessions independently of a refreshed live baseline', () => {
  const db=createMigratedMemoryDatabase();
  try {
    const entry=createEntry(db,{title:'Base',type:'game'});
    const base=buildSyncSnapshot(db); rememberSnapshot(db,base,'none');
    db.prepare('UPDATE entries SET title=? WHERE id=?').run('界'.repeat(6*1024*1024),entry.id);
    const request:SyncDeltaRequest={libraryId:base.header.libraryId,syncEpoch:base.header.syncEpoch,protocolVersion:1,clientId:'session-eviction',media:'none',baseChecksum:base.header.checksum,baseChangeSeq:base.header.changeSeq!,offset:0};
    const first=readSnapshotDelta(db,request);
    for(let index=0;index<3;index++) {rememberSnapshot(db,base,'none');readSnapshotDelta(db,{...request,clientId:`peer-${index}`});}
    rememberSnapshot(db,base,'none');
    expect(()=>readSnapshotDelta(db,{...request,token:first.token,offset:first.chunk.length})).toThrow(/session unavailable/i);
    expect(readSnapshotDelta(db,{...request,clientId:'fresh'}).done).toBe(false);
  } finally {db.close();}
});

it('bounds aggregate multibyte baselines by UTF8 bytes rather than UTF16 length', () => {
  const db=createMigratedMemoryDatabase();
  try {
    createEntry(db,{title:'Base',type:'game'});
    db.exec("INSERT INTO producers(id,name) VALUES(1,'Base')");
    db.prepare('UPDATE producers SET name=? WHERE id=1').run('界'.repeat(6*1024*1024));
    const bases=[];
    for(let index=0;index<3;index++) {const base=buildSyncSnapshot(db);rememberSnapshot(db,base,'none');bases.push(base);}
    expect(bases.reduce((n,row)=>n+JSON.stringify(row).length,0)).toBeLessThan(48*1024*1024);
    expect(bases.reduce((n,row)=>n+Buffer.byteLength(JSON.stringify(row)),0)).toBeGreaterThan(48*1024*1024);
    const base=bases[0]!;
    expect(()=>readSnapshotDelta(db,{libraryId:base.header.libraryId,syncEpoch:base.header.syncEpoch,protocolVersion:1,clientId:'bytes',media:'none',baseChecksum:base.header.checksum,baseChangeSeq:base.header.changeSeq!,offset:0})).toThrow(/baseline unavailable/i);
  } finally {db.close();}
});


it('freezes a multi-page UTF16 target across intervening SQL writes and grants only its completed journal cursor', () => {
  const db=createMigratedMemoryDatabase();
  try {
    const entry=createEntry(db,{title:'Base',type:'game'});
    const base=buildSyncSnapshot(db); rememberSnapshot(db,base,'none');
    const title='界😀'.repeat(24000);
    db.prepare('UPDATE entries SET title=? WHERE id=?').run(title,entry.id);
    const expected=buildSyncSnapshot(db).payload;
    const request:SyncDeltaRequest={libraryId:base.header.libraryId,syncEpoch:base.header.syncEpoch,protocolVersion:1,clientId:'frozen',media:'none',baseChecksum:base.header.checksum,baseChangeSeq:base.header.changeSeq!,offset:0};
    const first=readSnapshotDelta(db,request); expect(first.done).toBe(false);
    const ack={libraryId:request.libraryId,syncEpoch:request.syncEpoch,protocolVersion:1 as const,clientId:request.clientId,cursorSeq:first.target.changeSeq!};
    expect(()=>ackSyncChanges(db,ack)).toThrow();
    expect(()=>readSnapshotDelta(db,{...request,token:first.token,offset:32768})).toThrow();
    db.prepare('UPDATE entries SET title=? WHERE id=?').run('Later concurrent write',entry.id);
    let insert=first.chunk; let pages=1; let page=first;
    while (!page.done) {
      page=readSnapshotDelta(db,{...request,token:first.token,offset:insert.length});
      expect(page.target).toEqual(first.target); insert+=page.chunk; pages++;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    const text=JSON.stringify(base);
    const target=JSON.parse(text.slice(0,first.prefix)+insert+text.slice(first.prefix+first.remove));
    expect(target.header).toEqual(first.target); expect(target.payload).toEqual(expected);
    expect(target.payload.entries[0].title).toBe(title);
    expect(ackSyncChanges(db,ack)).toEqual({ackSeq:first.target.changeSeq});
    expect(()=>ackSyncChanges(db,{...ack,cursorSeq:buildSyncSnapshot(db).header.changeSeq!})).toThrow();
    expect(()=>readSnapshotDelta(db,{...request,token:first.token,clientId:'other'})).toThrow();
  } finally {db.close();}
});

it('expires server baselines exactly at the five-minute boundary', () => {
  const db=createMigratedMemoryDatabase();
  try {
    createEntry(db,{title:'Base',type:'game'});
    const base=buildSyncSnapshot(db); const now=Date.now();
    vi.spyOn(Date,'now').mockReturnValue(now);
    rememberSnapshot(db,base,'none');
    const request:SyncDeltaRequest={libraryId:base.header.libraryId,syncEpoch:base.header.syncEpoch,protocolVersion:1,clientId:'expiry',media:'none',baseChecksum:base.header.checksum,baseChangeSeq:base.header.changeSeq!,offset:0};
    vi.spyOn(Date,'now').mockReturnValue(now+5*60*1000);
    expect(()=>readSnapshotDelta(db,request)).toThrow(/baseline unavailable/i);
  } finally { vi.restoreAllMocks(); db.close(); }
});
