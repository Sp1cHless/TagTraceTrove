import { createHash } from 'node:crypto';
import type { T3Database } from '../database/connection.js';
import { createEntry } from '../repositories/entry-repository.js';
import type { CreateEntryInput } from '../repositories/entry-repository.js';

/** The POST fingerprint includes every field that can affect the initial Entry. */
export function onlineEntryCreateHash(input: Pick<CreateEntryInput,
  'title' | 'type' | 'uploadDate' | 'pageCount' | 'durationSeconds' | 'coverRef' | 'previewRef'>): string {
  return createHash('sha256').update(JSON.stringify([
    input.title.trim(), input.type.trim(), input.uploadDate ?? null, input.pageCount ?? null,
    input.durationSeconds ?? null,
    input.coverRef ?? null, input.previewRef ?? null,
  ])).digest('hex');
}

interface ClaimedEntry { requestHash: string; id: number; title: string; type: string;
  coverRef: string | null; previewRef: string | null; previewRefs: string; uploadDate: string | null; pageCount: number | null;
  durationSeconds: number | null; }
export function createOnlineEntry(database: T3Database, input: CreateEntryInput):
  { status: 'created' | 'retry' | 'conflict'; entry?: ReturnType<typeof createEntry> } {
  if (input.syncUid === undefined) return { status: 'created', entry: createEntry(database, input) };
  return database.transaction(() => {
    const hash = onlineEntryCreateHash(input);
    const claim = database.prepare(`
      SELECT claim.request_hash AS requestHash, entry.id, entry.title, entry.type,
        entry.cover_ref AS coverRef, entry.preview_ref AS previewRef,
        entry.preview_refs AS previewRefs, entry.upload_date AS uploadDate,
        entry.page_count AS pageCount, entry.duration_seconds AS durationSeconds
      FROM sync_online_entry_creates AS claim
      JOIN entries AS entry ON entry.sync_uid = claim.entry_uid
      WHERE claim.entry_uid = ?
    `).get(input.syncUid) as ClaimedEntry | undefined;
    if (claim !== undefined) {
      if (claim.requestHash !== hash) return { status: 'conflict' as const };
      return { status: 'retry' as const, entry: {
        id: claim.id, title: claim.title, type: claim.type, coverRef: claim.coverRef,
        previewRef: claim.previewRef, previewRefs: JSON.parse(claim.previewRefs) as string[],
        uploadDate: claim.uploadDate, pageCount: claim.pageCount,
        durationSeconds: claim.durationSeconds,
      } };
    }
    // Do not adopt arbitrary pre-existing Entries that lack a matching online claim.
    if (database.prepare('SELECT 1 FROM entries WHERE sync_uid = ?').get(input.syncUid)) {
      return { status: 'conflict' as const };
    }
    if (database.prepare(`
      SELECT 1 FROM sync_tombstones WHERE entity_kind = 'entry' AND entity_uid = ?
    `).get(input.syncUid)) return { status: 'conflict' as const };
    const entry = createEntry(database, input);
    database.prepare(`
      INSERT INTO sync_online_entry_creates (entry_uid, request_hash, entry_version)
      SELECT sync_uid, ?, sync_version FROM entries WHERE id = ?
    `).run(hash, entry.id);
    return { status: 'created' as const, entry };
  })();
}
