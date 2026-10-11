import { createMigratedMemoryDatabase } from '../../apps/server/src/database/testing.js';
const db=createMigratedMemoryDatabase();
console.log(JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (type='trigger' OR name IN ('sync_changes','sync_tombstones') OR (type='index' AND tbl_name IN ('sync_changes','sync_tombstones')))").all()));db.close();
