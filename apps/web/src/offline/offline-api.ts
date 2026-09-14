import type { GalleryApi } from '../api/gallery.js';
import { ApiError } from '../api/client.js';
import { createOfflineLibrary, type OfflineLibrary } from './offline-library.js';
import { ACTIVE_GENERATION_KEY, readActiveSnapshot, type SnapshotStore } from './snapshot-store.js';

/**
 * Online remains authoritative. Only an explicit set of read methods may fall
 * back to the last verified snapshot; every mutation keeps the original online
 * implementation and therefore fails closed while disconnected.
 */
export interface OfflineApiState {
  mode: 'online' | 'offline';
  lastFallbackAt: string | null;
}

function isOfflineTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof ApiError && [502, 503, 504].includes(error.status);
}

export function createOfflineAwareGalleryApi(
  online: GalleryApi,
  store: SnapshotStore,
  options: { state?: OfflineApiState } = {},
): GalleryApi {
  let mode: OfflineApiState['mode'] = options.state?.mode ?? 'online';
  let cachedGenerationId: string | null = null;
  let cachedLibrary: OfflineLibrary | null = null;

  function setMode(nextMode: OfflineApiState['mode']): void {
    mode = nextMode;
    if (options.state !== undefined) options.state.mode = nextMode;
  }

  async function loadOfflineLibrary(): Promise<OfflineLibrary | null> {
    const generationId = await store.readMeta(ACTIVE_GENERATION_KEY);
    if (generationId === null) return null;
    if (cachedLibrary !== null && cachedGenerationId === generationId) return cachedLibrary;
    const active = await readActiveSnapshot(store);
    if (active === null) return null;
    cachedGenerationId = generationId;
    cachedLibrary = createOfflineLibrary(active.snapshot);
    return cachedLibrary;
  }

  async function withFallback<T>(
    onlineCall: () => Promise<T>,
    offlineCall: (library: OfflineLibrary) => T,
  ): Promise<T> {
    if (mode === 'offline') {
      try {
        const library = await loadOfflineLibrary();
        if (library !== null) return offlineCall(library);
      } catch {
        // IndexedDB can be transiently unavailable; retry the authoritative API.
      }
      setMode('online');
    }
    try {
      const result = await onlineCall();
      setMode('online');
      return result;
    } catch (onlineError) {
      if (!isOfflineTransportError(onlineError)) throw onlineError;
      let library;
      try {
        library = await loadOfflineLibrary();
      } catch {
        throw onlineError;
      }
      if (library === null) throw onlineError;
      setMode('offline');
      if (options.state !== undefined) {
        options.state.lastFallbackAt = new Date().toISOString();
      }
      return offlineCall(library);
    }
  }

  return {
    ...online,
    async getSyncCapabilities() {
      const result = await online.getSyncCapabilities();
      setMode('online');
      return result;
    },
    async fetchSyncSnapshot() {
      const result = await online.fetchSyncSnapshot();
      setMode('online');
      return result;
    },
    getViewLaterState() {
      return withFallback(
        () => online.getViewLaterState(),
        (library) => library.getViewLaterState(),
      );
    },
    listGalleries() {
      return withFallback(
        () => online.listGalleries(),
        (library) => library.listGalleries(),
      );
    },
    queryEntryPage(input) {
      return withFallback(
        () => online.queryEntryPage(input),
        (library) => library.queryEntryPage(input),
      );
    },
    listFacetFilterOptions(entryType, authorId) {
      return withFallback(
        () => online.listFacetFilterOptions(entryType, authorId),
        (library) => library.listFacetFilterOptions(entryType, authorId),
      );
    },
    getEntry(entryId) {
      return withFallback(
        () => online.getEntry(entryId),
        (library) => library.getEntry(entryId),
      );
    },
    listCollections(kind, includeNsfw) {
      return withFallback(
        () => online.listCollections(kind, includeNsfw),
        (library) => library.listCollections(kind, includeNsfw),
      );
    },
    listCollectionsForEntry(entryId) {
      return withFallback(
        () => online.listCollectionsForEntry(entryId),
        (library) => library.listCollectionsForEntry(entryId),
      );
    },
    listAuthors() {
      return withFallback(
        () => online.listAuthors(),
        (library) => library.listAuthors(),
      );
    },
    queryProducerPage(input) {
      return withFallback(
        () => online.queryProducerPage(input),
        (library) => library.queryProducerPage(input),
      );
    },
    getAuthor(authorId) {
      return withFallback(
        () => online.getAuthor(authorId),
        (library) => library.getAuthor(authorId),
      );
    },
    listAuthorFilterOptions(entryType, includeNsfw) {
      return withFallback(
        () => online.listAuthorFilterOptions(entryType, includeNsfw),
        (library) => library.listAuthorFilterOptions(entryType, includeNsfw),
      );
    },
    searchTags(query, includeNsfw) {
      return withFallback(
        () => online.searchTags(query, includeNsfw),
        (library) => library.searchTags(query, includeNsfw),
      );
    },
    listGalleryTags(entryType) {
      return withFallback(
        () => online.listGalleryTags(entryType),
        (library) => library.listGalleryTags(entryType),
      );
    },
    listCollectionsForProducer(producerId) {
      return withFallback(
        () => online.listCollectionsForProducer(producerId),
        (library) => library.listCollectionsForProducer(producerId),
      );
    },
    listTaxonomyAliases(vocabulary) {
      return withFallback(
        () => online.listTaxonomyAliases(vocabulary),
        (library) => library.listTaxonomyAliases(vocabulary),
      );
    },
  };
}
