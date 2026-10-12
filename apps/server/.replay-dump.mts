import { readFileSync } from 'node:fs';
import { openDatabase } from './src/database/connection.js';
import { replaySyncOperation } from './src/sync/replay-service.js';

const dbPath = process.argv[2]!, opsPath = process.argv[3]!;
const ops = JSON.parse(readFileSync(opsPath, 'utf8')) as Array<{opId:string;operation:Record<string,unknown>}>;
const db = openDatabase(dbPath);
let applied = 0, blocked = 0;
for (const { opId, operation } of ops) {
  const kind = String(operation.operationKind);
  const { status: _s, lastAttemptAt: _a, lastError: _e, ...wire } = operation;
  void _s; void _a; void _e;
  try {
    const result = replaySyncOperation(db, wire as never);
    if (result.status !== 'applied') {
      // The real client marks this one and carries on with the rest.
      console.log('NOT-APPLIED', kind, opId.slice(0,8), result.status, (result as {detail?:string}).detail ?? '');
      blocked += 1;
      continue;
    }
    applied += 1;
  } catch (cause) {
    console.log('THREW', JSON.stringify({ opId, kind, name: cause instanceof Error ? cause.constructor.name : typeof cause, message: cause instanceof Error ? cause.message : String(cause), stack: cause instanceof Error ? String(cause.stack).split('\n').slice(0,8) : null }));
    break;
  }
}
console.log('APPLIED', applied, 'NOT-APPLIED', blocked, 'of', ops.length);
db.close();
