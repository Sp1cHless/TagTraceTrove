import { syncSnapshotSchema, type SyncSnapshot } from '@t3/shared';

/**
 * Offline snapshot store (plan §24.2/§24.3), web-first with an injectable
 * key-value backend. The PWA shell backs this with IndexedDB; tests use the
 * in-memory backend. Writes always go to a NEW generation; only a fully
 * verified snapshot atomically switches `activeGeneration`, so a failed or
 * interrupted download can never corrupt or remove the previous offline
 * library. Pending work (outbox, unsynced blobs — C2) lives OUTSIDE the
 * generation stores by design and is never touched here.
 */

export interface SnapshotStore {
  listGenerationIds(): Promise<number[]>;
  writeGeneration(generationId: number, value: string): Promise<void>;
  readGeneration(generationId: number): Promise<string | null>;
  deleteGeneration(generationId: number): Promise<void>;
  readMeta(key: string): Promise<string | null>;
  writeMeta(key: string, value: string): Promise<void>;
}

export function createMemorySnapshotStore(): SnapshotStore {
  const generations = new Map<number, string>();
  const meta = new Map<string, string>();
  return {
    async listGenerationIds() {
      return [...generations.keys()].sort((left, right) => left - right);
    },
    async writeGeneration(generationId, value) {
      generations.set(generationId, value);
    },
    async readGeneration(generationId) {
      return generations.get(generationId) ?? null;
    },
    async deleteGeneration(generationId) {
      generations.delete(generationId);
    },
    async readMeta(key) {
      return meta.get(key) ?? null;
    },
    async writeMeta(key, value) {
      meta.set(key, value);
    },
  };
}

export const ACTIVE_GENERATION_KEY = 'activeGeneration';

export interface SnapshotIdentity {
  libraryId: string;
  syncEpoch: string;
  snapshotSeq: number;
  snapshotFormatVersion: number;
}

function identityOf(snapshot: SyncSnapshot): SnapshotIdentity {
  return {
    libraryId: snapshot.header.libraryId,
    syncEpoch: snapshot.header.syncEpoch,
    snapshotSeq: snapshot.header.snapshotSeq,
    snapshotFormatVersion: snapshot.header.snapshotFormatVersion,
  };
}

export type ApplyFailure =
  | { reason: 'library-mismatch'; detail: string }
  | { reason: 'epoch-mismatch'; detail: string }
  | { reason: 'stale-snapshot'; detail: string }
  | { reason: 'checksum-mismatch'; detail: string }
  | { reason: 'quota'; detail: string }
  | { reason: 'parse'; detail: string };

export type ApplyResult =
  | { ok: true; generationId: number; identity: SnapshotIdentity; prunedGenerations: number[] }
  | { ok: false; failure: ApplyFailure };

/** Verify the checksum shipped with the snapshot (header minus checksum).
 * Uses WebCrypto, which exists in browsers and Node ≥ 19 alike; the
 * canonical serialization must stay byte-identical with the server's
 * `sha256(JSON(header) + JSON(payload))`. */
export async function verifyChecksum(snapshot: SyncSnapshot, expected: string): Promise<boolean> {
  const { checksum, ...header } = snapshot.header;
  void checksum;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(header) + JSON.stringify(snapshot.payload),
  ));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return hex === expected;
}

export interface ApplyOptions {
  store: SnapshotStore;
  /** The library the client currently holds (undefined on first download). */
  currentLibraryId?: string;
  currentSyncEpoch?: string;
  currentSnapshotSeq?: number;
}

export async function applySnapshot(
  snapshot: SyncSnapshot,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const parsed = syncSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return { ok: false, failure: { reason: 'parse', detail: parsed.error.issues[0]?.message ?? 'Invalid snapshot' } };
  }
  const validated = parsed.data;
  const { counts } = validated.header;
  const actualCounts = {
    entries: validated.payload.entries.length,
    producers: validated.payload.producers.length,
    entryContents: validated.payload.entryContents.length,
    entryTags: validated.payload.entryTags.length,
    collections: validated.payload.collections.length,
  };
  if (Object.entries(actualCounts).some(([key, value]) => counts[key as keyof typeof counts] !== value)) {
    return { ok: false, failure: { reason: 'parse', detail: 'Snapshot counts do not match its payload' } };
  }
  const identity = identityOf(validated);

  // Fail closed on identity mismatches: wrong library or a rotated epoch
  // means the client cannot reconcile; a resnapshot is required.
  if (options.currentLibraryId !== undefined && options.currentLibraryId !== identity.libraryId) {
    return { ok: false, failure: { reason: 'library-mismatch', detail: identity.libraryId } };
  }
  if (options.currentSyncEpoch !== undefined && options.currentSyncEpoch !== identity.syncEpoch) {
    return { ok: false, failure: { reason: 'epoch-mismatch', detail: identity.syncEpoch } };
  }
  if (options.currentSnapshotSeq !== undefined && identity.snapshotSeq <= options.currentSnapshotSeq) {
    return { ok: false, failure: { reason: 'stale-snapshot', detail: String(identity.snapshotSeq) } };
  }
  if (!(await verifyChecksum(validated, validated.header.checksum))) {
    return { ok: false, failure: { reason: 'checksum-mismatch', detail: validated.header.checksum } };
  }

  const previousActive = await options.store.readMeta(ACTIVE_GENERATION_KEY);
  // New generations are numbered above everything seen so far.
  const existingIds = await options.store.listGenerationIds();
  const generationId = Math.max(0, ...existingIds) + 1;

  try {
    await options.store.writeGeneration(generationId, JSON.stringify(validated));
  } catch (cause) {
    return { ok: false, failure: { reason: 'quota', detail: cause instanceof Error ? cause.message : String(cause) } };
  }

  // Atomic switch: the pointer move is the last write; anything failing
  // before it leaves the previous generation active and untouched.
  try {
    await options.store.writeMeta(ACTIVE_GENERATION_KEY, String(generationId));
  } catch (cause) {
    try {
      await options.store.deleteGeneration(generationId);
    } catch {
      // An unreferenced staged generation is safe and can be pruned later.
    }
    return {
      ok: false,
      failure: { reason: 'quota', detail: cause instanceof Error ? cause.message : String(cause) },
    };
  }

  // Keep one older generation for fallback; prune the rest.
  const pruned: number[] = [];
  for (const id of existingIds) {
    if (id !== Number(previousActive) && id !== generationId) {
      try {
        await options.store.deleteGeneration(id);
        pruned.push(id);
      } catch {
        // Cleanup is best-effort after the new active pointer is committed.
      }
    }
  }
  return {
    ok: true,
    generationId,
    identity,
    prunedGenerations: pruned,
  };
}

export interface ActiveSnapshot {
  generationId: number;
  snapshot: SyncSnapshot;
}

export async function readActiveSnapshot(
  store: SnapshotStore,
): Promise<ActiveSnapshot | null> {
  const active = await store.readMeta(ACTIVE_GENERATION_KEY);
  if (active === null) return null;
  const generationId = Number(active);
  const raw = await store.readGeneration(generationId);
  if (raw === null) return null;
  try {
    const parsed = syncSnapshotSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? { generationId, snapshot: parsed.data } : null;
  } catch {
    return null;
  }
}
