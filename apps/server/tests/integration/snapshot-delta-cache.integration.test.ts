import { expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { buildSyncSnapshot, getSyncIdentity } from '../../src/sync/sync-service.js';
import { readSnapshotDelta, rememberSnapshot } from '../../src/sync/snapshot-delta.js';

it('retains a newly fetched baseline when old completed sessions fill the cache',()=>{
  const db=createMigratedMemoryDatabase();try{
    const identity=getSyncIdentity(db);
    for(let index=0;index<24;index++){
      const base=buildSyncSnapshot(db,{media:'thumbnails'});rememberSnapshot(db,base,'thumbnails');
      const page=readSnapshotDelta(db,{libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,protocolVersion:1,clientId:'cache-pressure',media:'thumbnails',baseChecksum:base.header.checksum,baseChangeSeq:base.header.changeSeq!,offset:0});
      expect(page.done).toBe(true);expect(page.target.snapshotSeq).toBeGreaterThan(base.header.snapshotSeq);
    }
  }finally{db.close();}
});
