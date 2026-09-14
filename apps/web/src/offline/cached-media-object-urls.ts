import { matchCachedMediaResponse, type CachedMediaStorage } from './cached-media-response.js';

export interface MediaObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface CachedMediaObjectUrlHandle {
  sourceUrl: string;
  objectUrl: string;
  loaded: boolean;
}

interface RegistryEntry {
  sourceUrl: string;
  objectUrl: string;
  loaded: boolean;
  references: number;
  objectUrls: MediaObjectUrlApi;
}

export class CachedMediaObjectUrlRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly pending = new Map<string, Promise<RegistryEntry | null>>();
  private epoch = 0;

  constructor(private readonly maxEntries = 256) {}

  get size(): number {
    return this.entries.size;
  }

  async acquire(
    sourceUrl: string,
    cacheStorage: CachedMediaStorage | undefined = globalThis.caches,
    objectUrls: MediaObjectUrlApi = URL,
  ): Promise<CachedMediaObjectUrlHandle | null> {
    let entry = this.entries.get(sourceUrl);
    if (entry === undefined) {
      let pending = this.pending.get(sourceUrl);
      if (pending === undefined) {
        const epoch = this.epoch;
        pending = this.createEntry(sourceUrl, cacheStorage, objectUrls, epoch);
        this.pending.set(sourceUrl, pending);
        void pending.finally(() => {
          if (this.pending.get(sourceUrl) === pending) this.pending.delete(sourceUrl);
        });
      }
      entry = await pending ?? undefined;
    }
    if (entry === undefined) return null;
    entry.references += 1;
    this.touch(entry);
    this.evictUnusedEntries();
    return { sourceUrl, objectUrl: entry.objectUrl, loaded: entry.loaded };
  }

  markLoaded(handle: CachedMediaObjectUrlHandle): void {
    const entry = this.entries.get(handle.sourceUrl);
    if (entry?.objectUrl !== handle.objectUrl) return;
    entry.loaded = true;
    handle.loaded = true;
    this.touch(entry);
  }

  release(handle: CachedMediaObjectUrlHandle): void {
    const entry = this.entries.get(handle.sourceUrl);
    if (entry?.objectUrl !== handle.objectUrl) return;
    entry.references = Math.max(0, entry.references - 1);
    this.touch(entry);
    this.evictUnusedEntries();
  }

  discard(handle: CachedMediaObjectUrlHandle): void {
    const entry = this.entries.get(handle.sourceUrl);
    if (entry?.objectUrl !== handle.objectUrl) return;
    this.entries.delete(handle.sourceUrl);
    entry.objectUrls.revokeObjectURL(entry.objectUrl);
  }

  clear(): void {
    this.epoch += 1;
    for (const entry of this.entries.values()) entry.objectUrls.revokeObjectURL(entry.objectUrl);
    this.entries.clear();
  }

  private async createEntry(
    sourceUrl: string,
    cacheStorage: CachedMediaStorage | undefined,
    objectUrls: MediaObjectUrlApi,
    epoch: number,
  ): Promise<RegistryEntry | null> {
    try {
      const response = await matchCachedMediaResponse(sourceUrl, cacheStorage);
      if (response === null) return null;
      const objectUrl = objectUrls.createObjectURL(await response.blob());
      if (epoch !== this.epoch) {
        objectUrls.revokeObjectURL(objectUrl);
        return null;
      }
      const entry: RegistryEntry = {
        sourceUrl,
        objectUrl,
        loaded: false,
        references: 0,
        objectUrls,
      };
      this.entries.set(sourceUrl, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private touch(entry: RegistryEntry): void {
    this.entries.delete(entry.sourceUrl);
    this.entries.set(entry.sourceUrl, entry);
  }

  private evictUnusedEntries(): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [sourceUrl, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.references !== 0) continue;
      this.entries.delete(sourceUrl);
      entry.objectUrls.revokeObjectURL(entry.objectUrl);
    }
  }
}

export const cachedMediaObjectUrls = new CachedMediaObjectUrlRegistry();
