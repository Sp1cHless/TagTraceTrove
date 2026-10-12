<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { GalleryApi } from '../api/gallery.js';
import { cancelMediaPreload, saveMediaPreloadChoice, startMediaPreload, type MediaPreloadMode } from '../offline/offline-media-task.js';
import { clearOfflineSnapshot, downloadOfflineSnapshot } from '../offline/offline-sync.js';
import { SNAPSHOT_MEDIA_KEY } from '../offline/client-identity.js';
import { allOfflineMediaCacheNames } from '../offline/cache-names.js';
import { cachedMediaObjectUrls } from '../offline/cached-media-object-urls.js';
import { readActiveSnapshot, type ActiveSnapshot, type SnapshotStore } from '../offline/snapshot-store.js';
import type { OutboxStore } from '../offline/outbox-store.js';
import type { MediaOutboxStore } from '../offline/media-outbox-store.js';
import { useI18n } from '../i18n.js';

const emit = defineEmits<{ updated: [] }>();
const props = withDefaults(defineProps<{
  api: Pick<GalleryApi, 'assetUrl' | 'getSyncCapabilities' | 'fetchSyncSnapshot' | 'flushOfflineOutbox' | 'resumeNativeTransfers'>;
  store: SnapshotStore;
  online?: boolean;
  copyRevision?: string | null;
}>(), { online: true });

const { t } = useI18n();
const active = ref<ActiveSnapshot | null>(null);
const busy = ref(false);
const issue = ref<string | null>(null);
const mediaStatus = ref<string | null>(null);
const preloadMode = ref<MediaPreloadMode>('thumbnails');
const selectedOriginalRefs = ref('');
const storageStatus = ref<string | null>(null);
const persistenceStatus = ref<string | null>(null);
const contentCapability = ref<string | null>(null);
const editingSupport = ref<string | null>(null);
const pendingStore = props.store as SnapshotStore & Partial<Pick<OutboxStore, 'list'> & Pick<MediaOutboxStore, 'listMedia'>>;

const contentSupport = computed(() => {
  if (active.value === null) return null;
  if (contentCapability.value !== '1') return t('offline.contentNotEnabled');
  if (active.value.snapshot.payload.entryContents.some((row) => !row.syncUid || row.syncVersion === undefined)) {
    return t('offline.contentNeedsRefresh');
  }
  return t('offline.contentReady');
});

const status = computed(() => {
  if (issue.value !== null) return t('offline.error', { detail: issue.value });
  if (active.value === null) return t('offline.empty');
  const count = active.value.snapshot.header.counts.entries;
  return t(count === 1 ? 'offline.readyOne' : 'offline.ready', {
    count,
    sequence: active.value.snapshot.header.snapshotSeq,
  });
});

async function refreshStorageEstimate(): Promise<void> {
  if (typeof navigator.storage?.estimate !== 'function') { storageStatus.value = t('offline.storageUnavailable'); return; }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage !== undefined && quota !== undefined) {
      storageStatus.value = t('offline.storageEstimate', {
        usage: (usage / 1_048_576).toFixed(1), quota: (quota / 1_048_576).toFixed(1),
      });
    }
  } catch (cause) {
    storageStatus.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function requestPersistence(): Promise<void> {
  if (typeof navigator.storage?.persist !== 'function') { persistenceStatus.value = t('offline.persistenceUnavailable'); return; }
  try {
    const granted = await navigator.storage.persist();
    persistenceStatus.value = t(granted ? 'offline.persistenceGranted' : 'offline.persistenceDenied');
    await refreshStorageEstimate();
  } catch (cause) {
    persistenceStatus.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function refreshStatus(): Promise<void> {
  try {
    [active.value, contentCapability.value] = await Promise.all([
      readActiveSnapshot(props.store),
      props.store.readMeta('capability.offlineEntryContents'),
    ]);
    const saved = await props.store.readMeta('mediaPreloadChoice');
    const capabilityReport = JSON.parse(await props.store.readMeta('offlineCapabilityReport') ?? 'null');
    if (capabilityReport?.featureFlags) {
      const flags = Object.entries(capabilityReport.featureFlags).filter(([key]) => key.startsWith('offline') && key !== 'offlineMutations');
      editingSupport.value = t('offline.editSupportSummary', { enabled: capabilityReport.featureFlags.offlineMutations === true ? flags.filter(([, value]) => value === true).length : 0, total: flags.length });
    }
    if (saved) {
      const choice = JSON.parse(saved) as {mode?: MediaPreloadMode;selectedRefs?: unknown};
      if (choice.mode && ['metadata','thumbnails','selected-originals'].includes(choice.mode)
        && Array.isArray(choice.selectedRefs) && choice.selectedRefs.every(ref => typeof ref === 'string')) {
        preloadMode.value = choice.mode; selectedOriginalRefs.value = choice.selectedRefs.join('\n');
      }
    }
  } catch (cause) {
    issue.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function download(): Promise<void> {
  busy.value = true;
  issue.value = null;
  try {
    const selectedRefs = selectedOriginalRefs.value.split(/[\s,]+/u).filter(Boolean);
    await saveMediaPreloadChoice(props.store, preloadMode.value, selectedRefs);
    const media = preloadMode.value === 'metadata' ? 'none' : 'thumbnails';
    await props.store.writeMeta(SNAPSHOT_MEDIA_KEY, media);
    const capabilities = await props.api.getSyncCapabilities({replay:false});
    await props.api.flushOfflineOutbox?.();
    // Replay can install a covering candidate itself. Capture Update's base only
    // after that awaited, explicit boundary, not before a probe's implicit replay.
    const result = await downloadOfflineSnapshot({ api: props.api, store: props.store, media, capabilities });
    if (!result.ok) {
      issue.value = t(`offline.failure.${result.reason}`, { detail: result.detail });
      return;
    }
    active.value = result.active;
    // The copy just changed underneath every list the app is showing.
    emit('updated');
    contentCapability.value = await props.store.readMeta('capability.offlineEntryContents');
    if (typeof globalThis.caches === 'undefined') {
      mediaStatus.value = t('offline.mediaUnavailable');
      return;
    }
    try {
      const selected = selectedOriginalRefs.value.split(/[\s,]+/u).filter((ref) => result.active.snapshot.payload.mediaRefs.includes(ref));
      await saveMediaPreloadChoice(props.store, preloadMode.value, selected);
      const media = await startMediaPreload({
        store: props.store, assetUrl: props.api.assetUrl, cacheStorage: globalThis.caches,
        onProgress(progress) {
          mediaStatus.value = t(progress.phase === 'preparing' ? 'offline.mediaPreparing' : 'offline.mediaProgress', {
            processed: progress.processed, total: progress.total,
          });
        },
      });
      cachedMediaObjectUrls.clear();
      if (media) mediaStatus.value = t('offline.mediaResult', {
        cached: media.cached,
        skipped: media.skipped,
        failed: media.failed,
      });
    } catch (cause) {
      cachedMediaObjectUrls.clear();
      mediaStatus.value = t('offline.mediaError', {
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  } catch (cause) {
    issue.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}


async function clearOffline(): Promise<void> {
  busy.value = true;
  issue.value = null;
  try {
    const [operations, uploads] = await Promise.all([
      pendingStore.list?.() ?? [],
      pendingStore.listMedia?.() ?? [],
    ]);
    if (operations.length > 0 || uploads.length > 0) {
      issue.value = t('offline.pendingBlocksClear');
      return;
    }
    await cancelMediaPreload(props.store);
    await clearOfflineSnapshot(props.store);
    if (typeof globalThis.caches !== 'undefined') {
      // Every bucket the media cache is split into, plus the pre-shard one.
      await Promise.all(allOfflineMediaCacheNames().map((name) => globalThis.caches.delete(name)));
    }
    cachedMediaObjectUrls.clear();
    active.value = null;
    mediaStatus.value = null;
    // Nothing is left to project offline reads onto.
    emit('updated');
  } catch (cause) {
    issue.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function refreshSystemInformation(): Promise<void> {
  if (props.online) {
    try { await props.api.getSyncCapabilities({ replay: false }); }
    catch (cause) { issue.value = cause instanceof Error ? cause.message : String(cause); }
  }
  await refreshStatus();
  await requestPersistence();
  await refreshStorageEstimate();
}
onMounted(() => { void refreshSystemInformation(); });
watch(() => props.online, () => { void refreshSystemInformation(); });
watch(() => props.copyRevision, () => { void refreshStatus(); void refreshStorageEstimate(); });
</script>

<template>
  <section class="offline-settings" data-testid="offline-settings">
    <div>
      <strong>{{ t('offline.title') }}</strong>
      <p data-testid="offline-status">{{ status }}</p>
    </div>
    <label>{{ t('offline.mediaLabel') }}
      <select v-model="preloadMode" data-testid="offline-media-mode">
        <option value="metadata">{{ t('offline.mediaMetadata') }}</option>
        <option value="thumbnails">{{ t('offline.mediaThumbnails') }}</option>
        <option value="selected-originals">{{ t('offline.mediaOriginals') }}</option>
      </select>
    </label>
    <label v-if="preloadMode === 'selected-originals'">{{ t('offline.originalsRefs') }}
      <textarea v-model="selectedOriginalRefs" data-testid="offline-selected-originals" />
    </label>
    <small>{{ t('offline.preloadNote') }}</small>
    <button
      type="button"
      data-testid="offline-download"
      :disabled="busy || !online"
      @click="download"
    >
      {{ busy ? t('offline.downloading') : t(active === null ? 'offline.download' : 'offline.update') }}
    </button>
    <button
      v-if="active !== null"
      type="button"
      data-testid="offline-clear"
      :disabled="busy"
      @click="clearOffline"
    >
      {{ t('offline.clear') }}
    </button>
    <small>{{ t('offline.hint') }}</small>
    <small v-if="mediaStatus" data-testid="offline-media-status">{{ mediaStatus }}</small>
    <section class="offline-system-information" data-testid="offline-system-information">
      <strong>{{ t('offline.systemInformation') }}</strong>
      <small v-if="editingSupport" data-testid="offline-edit-support">{{ editingSupport }}</small>
      <small v-if="contentSupport" data-testid="offline-content-support">{{ contentSupport }}</small>
      <small v-if="storageStatus" data-testid="offline-storage-status">{{ storageStatus }}</small>
      <small v-if="persistenceStatus" data-testid="offline-persistence-status">{{ persistenceStatus }}</small>
      <slot name="diagnostics" />
    </section>
  </section>
</template>

<style scoped>
.offline-settings {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  overflow-wrap: anywhere;
  gap: 0.55rem;
  margin-top: 0.9rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--border-subtle);
}
/* Labels, file inputs and native status must fit the enclosing Advanced card. */
.offline-settings > *, .offline-settings section > * { min-width: 0; max-width: 100%; }
.offline-settings label { display: grid; gap: 0.35rem; }
.offline-system-information { display: grid; gap: 0.35rem; }
.offline-settings input, .offline-settings select, .offline-settings textarea, .offline-settings button { min-width: 0; max-width: 100%; box-sizing: border-box; }
.offline-settings textarea { width: 100%; }
.offline-settings p,
.offline-settings small {
  margin: 0.2rem 0 0;
  color: var(--text-muted);
  font-size: 0.76rem;
}
.offline-settings button {
  min-height: 2.5rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.6rem;
  color: var(--text-primary);
  background: var(--surface-muted);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.offline-settings button:disabled {
  cursor: wait;
  opacity: 0.65;
}
</style>
