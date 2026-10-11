import { syncSnapshotSchema, type SyncSnapshot, type SyncAckRequest } from '@t3/shared';

/**
 * Offline snapshot store (plan §24.2/§24.3), web-first with an injectable
 * key-value backend. The PWA shell backs this with IndexedDB; tests use the
 * in-memory backend. Writes always go to a NEW generation; only a fully
 * verified snapshot atomically switches `activeGeneration`, so a failed or
 * interrupted download can never corrupt or remove the previous offline
 * library. Pending work (outbox, unsynced blobs — C2) lives OUTSIDE the
 * generation stores by design and is never touched here.
 */

export interface SnapshotState { active: ActiveSnapshot | null; revision: string }
export interface SnapshotStore {
  captureSnapshot?(): Promise<SnapshotState>;
  getOrCreateMeta?(key: string, create: () => string): Promise<string>;
  clearSnapshot?(): Promise<void>;
  installSnapshot?(base: ActiveSnapshot | null, value: string, acknowledgement?: SyncAckRequest, revision?: string, clientId?: string, discardPrevious?: boolean): Promise<number | { generationId: number; prunedGenerations: number[]; revision?: string } | null>;
  compareSnapshotMeta?(active: ActiveSnapshot | null, key: string, expected: string | null, value: string | null, clientId?: string): Promise<boolean>;
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
    async captureSnapshot() { return snapshotState(meta.get(ACTIVE_GENERATION_KEY), generations.get(Number(meta.get(ACTIVE_GENERATION_KEY))), meta.get(SNAPSHOT_REVISION_KEY)); },
    async clearSnapshot() { meta.set(SNAPSHOT_REVISION_KEY, nextSnapshotRevision(meta.get(SNAPSHOT_REVISION_KEY))); meta.set(ACTIVE_GENERATION_KEY, '0'); meta.delete(PENDING_SNAPSHOT_ACK_KEY); generations.clear(); },
    async getOrCreateMeta(key, create) {
      const existing = meta.get(key);
      if (existing !== undefined) return existing;
      const value = create(); meta.set(key, value); return value;
    },
    async compareSnapshotMeta(active, key, expected, value, clientId) {
      if ((active?.revision !== undefined && (meta.get(SNAPSHOT_REVISION_KEY) ?? '0') !== active.revision) || (clientId !== undefined && meta.get('t3.offline-client-id') !== clientId) || (meta.get(key) ?? null) !== expected || (active
        ? meta.get(ACTIVE_GENERATION_KEY) !== String(active.generationId) || generations.get(active.generationId) !== JSON.stringify(active.snapshot)
        : meta.has(ACTIVE_GENERATION_KEY) && meta.get(ACTIVE_GENERATION_KEY) !== '0')) return false;
      if (value === null) meta.delete(key); else meta.set(key, value);
      return true;
    },
    async installSnapshot(base, value, acknowledgement, revision = base?.revision, clientId = acknowledgement?.clientId, discardPrevious = false) {
      if (clientId !== undefined && meta.get('t3.offline-client-id') !== clientId) return null;
      if (revision !== undefined && (meta.get(SNAPSHOT_REVISION_KEY) ?? '0') !== revision) return null;
      const active = meta.get(ACTIVE_GENERATION_KEY);
      if (base ? active !== String(base.generationId) || generations.get(base.generationId) !== JSON.stringify(base.snapshot)
        : active !== undefined && active !== '0') return null;
      if (meta.has(PENDING_SNAPSHOT_ACK_KEY)) return null;
      const id = Math.max(0, ...generations.keys()) + 1;
      const nextRevision=nextSnapshotRevision(meta.get(SNAPSHOT_REVISION_KEY));
      const pending=acknowledgement ? JSON.stringify({generationId:id,snapshot:value,body:acknowledgement,revision:nextRevision}) : undefined;
      meta.set(SNAPSHOT_REVISION_KEY, nextRevision);
      generations.set(id, value); meta.set(ACTIVE_GENERATION_KEY, String(id));
      if (pending !== undefined) meta.set(PENDING_SNAPSHOT_ACK_KEY, pending);
      const prunedGenerations = [...generations.keys()].filter(key => key !== id && (discardPrevious || key !== base?.generationId));
      for (const key of prunedGenerations) generations.delete(key);
      return {generationId:id,prunedGenerations,revision:nextRevision};
    },
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

export const SNAPSHOT_REVISION_KEY = 'snapshotRevision';
export function nextSnapshotRevision(value: string | undefined): string { return String(BigInt(value ?? '0') + 1n); }
export function snapshotState(pointer: unknown, raw: unknown, revision: unknown): SnapshotState {
  const token = typeof revision === 'string' ? revision : '0';
  try {
    const parsed = typeof raw === 'string' ? syncSnapshotSchema.safeParse(JSON.parse(raw) as unknown) : null;
    return { revision: token, active: parsed?.success ? { generationId: Number(pointer), snapshot: parsed.data, revision: token } : null };
  } catch { return { active: null, revision: token }; }
}
export const ACTIVE_GENERATION_KEY = 'activeGeneration';
export const PENDING_SNAPSHOT_ACK_KEY = 'pendingSnapshotAck';

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
  | { ok: true; generationId: number; identity: SnapshotIdentity; prunedGenerations: number[]; revision?: string }
  | { ok: false; failure: ApplyFailure };

/** Verify the checksum shipped with the snapshot (header minus checksum).
 * Uses WebCrypto, which exists in browsers and Node ≥ 19 alike; the
 * canonical serialization must stay byte-identical with the server's
 * `sha256(JSON(header) + JSON(payload))`. */
// SHA-256 fallback for insecure LAN HTTP origins where WebCrypto is unavailable.
// Keep the same UTF-8 bytes and canonical serialization as the server checksum.
function sha256Fallback(input: Uint8Array): Uint8Array {
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) {
    if (primes.every((prime) => n % prime !== 0)) primes.push(n);
  }
  const fraction = (value: number) => (value - Math.floor(value)) * 0x100000000 >>> 0;
  const state = primes.slice(0, 8).map((prime) => fraction(Math.sqrt(prime)));
  const constants = primes.map((prime) => fraction(Math.cbrt(prime)));
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const rotate = (value: number, count: number) => (value >>> count) | (value << (32 - count));
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!;
      const b = words[i - 2]!;
      words[i] = (words[i - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3))
        + words[i - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const choose = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + choose + constants[i]! + words[i]!) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) {
      state[index] = (state[index]! + value) >>> 0;
    }
  }
  const output = new Uint8Array(32);
  const result = new DataView(output.buffer);
  state.forEach((value, index) => result.setUint32(index * 4, value));
  return output;
}

export async function verifyChecksum(snapshot: SyncSnapshot, expected: string): Promise<boolean> {
  const { checksum, ...header } = snapshot.header;
  void checksum;
  const bytes = new TextEncoder().encode(JSON.stringify(header) + JSON.stringify(snapshot.payload));
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    : sha256Fallback(bytes);
  const hex = [...digest]
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
  /** Captured before network/digest work; null explicitly means no active library. */
  expectedBase?: ActiveSnapshot | null;
  acknowledgement?: SyncAckRequest;
  expectedRevision?: string;
  expectedClientId?: string;
}

export async function applySnapshot(
  snapshot: SyncSnapshot,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const captured = options.store.captureSnapshot ? await options.store.captureSnapshot() : undefined;
  const base = options.expectedBase !== undefined ? options.expectedBase : captured?.active ?? null;
  const revision = options.expectedRevision ?? (options.expectedBase !== undefined ? options.expectedBase?.revision : captured?.revision);
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

  if (options.expectedBase !== undefined && !options.store.captureSnapshot) return {ok:false,failure:{reason:'stale-snapshot',detail:'Snapshot adapter requires a transactional capture token for Update'}};
  if (options.store.installSnapshot) {
    try {
      const installed = await options.store.installSnapshot(base, JSON.stringify(validated), options.acknowledgement, revision, options.expectedClientId, base !== null && base.snapshot.header.syncEpoch !== validated.header.syncEpoch);
      if (installed === null) return {ok:false,failure:{reason:'stale-snapshot',detail:'Active snapshot changed during download'}};
      const {generationId,prunedGenerations} = typeof installed === 'number'
        ? {generationId:installed,prunedGenerations:[]} : installed;
      return {ok:true,generationId,identity,prunedGenerations,...(typeof installed !== 'number' && installed.revision !== undefined ? {revision:installed.revision} : {})};
    } catch (cause) {
      return {ok:false,failure:{reason:'quota',detail:cause instanceof Error ? cause.message : String(cause)}};
    }
  }
  // A legacy adapter cannot make a captured full candidate conditional either.
  // Read-only full fallback is allowed, but Update must fail closed rather than
  // resurrect data after Clear or a peer replacement through split writes.
  if (options.expectedBase !== undefined) return {ok:false,failure:{reason:'stale-snapshot',detail:'Snapshot adapter requires atomic conditional activation for Update'}};
  // Unconditional low-level legacy writes remain available for initialization.
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
  revision?: string;
  generationId: number;
  snapshot: SyncSnapshot;
}

/**
 * The projected active snapshot, kept per store and invalidated by what identifies
 * it: the snapshot revision and the active generation pointer.
 *
 * Projecting means validating the entire library (tens of milliseconds for a
 * phone-sized snapshot, and it is reached from every read through the offline
 * facade), so paying it again for each call serialised the page behind it: an
 * Entry open issued its own request several hundred milliseconds late, and the
 * media walk re-projected on every guard. Both keys are tiny meta reads, and
 * every stored snapshot moves at least one of them. Callers only read the
 * projection.
 */
const activeSnapshotCache = new WeakMap<SnapshotStore, { key: string; active: ActiveSnapshot | null }>();

export async function readActiveSnapshot(
  store: SnapshotStore,
): Promise<ActiveSnapshot | null> {
  if (store.captureSnapshot) {
    const key = `${await store.readMeta(SNAPSHOT_REVISION_KEY) ?? '0'}|${await store.readMeta(ACTIVE_GENERATION_KEY) ?? '0'}`;
    const cached = activeSnapshotCache.get(store);
    if (cached !== undefined && cached.key === key) return cached.active;
    const captured = (await store.captureSnapshot()).active;
    activeSnapshotCache.set(store, { key, active: captured });
    return captured;
  }
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
