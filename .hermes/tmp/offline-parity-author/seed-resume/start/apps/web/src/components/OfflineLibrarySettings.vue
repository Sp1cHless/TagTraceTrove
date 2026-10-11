<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { MAX_RESTORE_FILE_BYTES, type PendingWorkRestorePreview } from '../offline/pending-work-restore.js';
import type { GalleryApi } from '../api/gallery.js';
import { cancelMediaPreload, saveMediaPreloadChoice, startMediaPreload, type MediaPreloadMode } from '../offline/offline-media-task.js';
import { clearOfflineSnapshot, downloadOfflineSnapshot } from '../offline/offline-sync.js';
import { SNAPSHOT_MEDIA_KEY } from '../offline/client-identity.js';
import { allOfflineMediaCacheNames } from '../offline/cache-names.js';
import { cachedMediaObjectUrls } from '../offline/cached-media-object-urls.js';
import { readActiveSnapshot, type ActiveSnapshot, type SnapshotStore } from '../offline/snapshot-store.js';
import type { OutboxStore } from '../offline/outbox-store.js';
import type { MediaOutboxStore } from '../offline/media-outbox-store.js';
import { buildPendingWorkExport } from '../offline/pending-work-export.js';
import { useI18n } from '../i18n.js';

const emit = defineEmits<{ updated: [] }>();
const props = withDefaults(defineProps<{
  api: Pick<GalleryApi, 'assetUrl' | 'getSyncCapabilities' | 'fetchSyncSnapshot' | 'flushOfflineOutbox' | 'previewPendingWorkRestore' | 'restorePendingWork' | 'resumeNativeTransfers'>;
  store: SnapshotStore;
  online?: boolean;
}>(), { online: true });

const { t } = useI18n();
const active = ref<ActiveSnapshot | null>(null);
const busy = ref(false);
const issue = ref<string | null>(null);
/** The export button sits far below the page-top status line; its result speaks here. */
const exportResult = ref<string | null>(null);
const mediaStatus = ref<string | null>(null);
const nativeStatus = ref<string | null>(null);
async function resumeNative(): Promise<void> {
  if (busy.value) return;
  busy.value=true;
  try {
    const status=await props.api.resumeNativeTransfers?.();
    if(!disposed && status)nativeStatus.value=`${status.active} scheduled, ${status.completed} uploaded awaiting foreground verification, ${status.held} held, ${status.dependencyHeld ?? 0} waiting for dependencies, ${status.capabilityHeld ?? 0} current-capability held, ${status.remainingOperations} foreground-only, ${status.standaloneMedia ?? 0} existing-Entry images. ${status.foregroundMedia ?? 0} images require foreground Update (native limit 20 MiB); original images stay queued. ${status.foregroundReason ?? ''}`;
  } catch { if(!disposed)nativeStatus.value='Native transfer paused; original pending work kept. Use Update to reconcile.'; }
  finally { if(!disposed)busy.value=false; }
}
const preloadMode = ref<MediaPreloadMode>('thumbnails');
const selectedOriginalRefs = ref('');
const storageStatus = ref<string | null>(null);
const persistenceStatus = ref<string | null>(null);
const contentCapability = ref<string | null>(null);
const pendingStore = props.store as SnapshotStore & Partial<Pick<OutboxStore, 'list'> & Pick<MediaOutboxStore, 'listMedia'>>;
const canExport = typeof pendingStore.list === 'function' && typeof pendingStore.listMedia === 'function';
const canRestore = typeof props.api.previewPendingWorkRestore === 'function' && typeof props.api.restorePendingWork === 'function';
const restorePreview = ref<PendingWorkRestorePreview | null>(null);
const restoreIssue = ref<string | null>(null);
const restoreResult = ref<string | null>(null);
let restoreText: string | null = null;
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
async function selectRestoreFile(event: Event): Promise<void> {
  if (busy.value || !canRestore) return;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy.value = true; restorePreview.value = null; restoreText = null; restoreIssue.value = null;
  try {
    if (file.size > MAX_RESTORE_FILE_BYTES) throw new Error('Pending-work file exceeds the safe 96 MiB limit');
    const text = await file.text();
    if (disposed) return;
    const preview = await props.api.previewPendingWorkRestore!(text);
    if (!disposed) { restoreText = text; restorePreview.value = preview; }
  } catch (cause) { if (!disposed) restoreIssue.value = cause instanceof Error ? cause.message : 'Unable to preview pending work'; }
  finally { busy.value = false; }
}
async function confirmRestore(): Promise<void> {
  if (busy.value || disposed || !restorePreview.value || restoreText === null || !canRestore) return;
  busy.value = true; restoreIssue.value = null;
  try {
    const result = await props.api.restorePendingWork!(restoreText);
    if (!disposed) {
      restoreResult.value = `Restored ${result.addedOperations} edits and ${result.addedMedia} images. Kept ${result.identicalOperations} identical live edits and ${result.identicalMedia} images unchanged. Choose Update when you want to send pending work.`;
      restorePreview.value = null; restoreText = null;
      emit('updated');
      try { active.value = await readActiveSnapshot(props.store); }
      catch { restoreIssue.value = 'Work was restored, but the display could not refresh. Do not import again; reopen Settings.'; }
    }
  } catch (cause) { if (!disposed) restoreIssue.value = cause instanceof Error ? cause.message : 'Restore failed; nothing was restored'; }
  finally { busy.value = false; }
}
const canRequestPersistence = typeof navigator.storage?.persist === 'function';

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
  if (typeof navigator.storage?.estimate !== 'function') return;
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
  if (typeof navigator.storage?.persist !== 'function') return;
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

async function checkEditingSupport(): Promise<void> {
  busy.value = true;
  issue.value = null;
  try {
    await props.api.getSyncCapabilities({ replay: false });
    contentCapability.value = await props.store.readMeta('capability.offlineEntryContents');
  } catch (cause) {
    issue.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function syncNow(): Promise<void> {
  // The facade probes identity, replays pending edits, and the explicit
  // download then pulls a fresh snapshot even if the Outbox was empty.
  await download();
}

async function exportPending(): Promise<void> {
  if (!canExport) return;
  busy.value = true;
  issue.value = null;
  exportResult.value = null;
  try {
    const exportData = await buildPendingWorkExport(pendingStore as SnapshotStore & Pick<OutboxStore, 'list'> & Pick<MediaOutboxStore, 'listMedia'>);
    if (exportData.operations.length === 0 && exportData.media.length === 0) {
      // The page-top status is out of sight from the button on a phone; say it here.
      exportResult.value = t('offline.noPending');
      return;
    }
    const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `t3-pending-work-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`;
    document.body.append(link);
    try { link.click(); } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    // The download itself is silent; say what just left the device.
    exportResult.value = t('offline.exported', {
      operations: exportData.operations.length,
      media: exportData.media.length,
    });
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

onMounted(() => { void refreshStatus(); void refreshStorageEstimate(); });
</script>

<template>
  <section class="offline-settings" data-testid="offline-settings">
    <div>
      <strong>{{ t('offline.title') }}</strong>
      <p data-testid="offline-status">{{ status }}</p>
    </div>
    <label>Offline media
      <select v-model="preloadMode" data-testid="offline-media-mode">
        <option value="metadata">Metadata only (no images)</option>
        <option value="thumbnails">Thumbnails (no originals)</option>
        <option value="selected-originals">Selected originals</option>
      </select>
    </label>
    <label v-if="preloadMode === 'selected-originals'">Original asset refs (comma or newline separated)
      <textarea v-model="selectedOriginalRefs" data-testid="offline-selected-originals" />
    </label>
    <small>Preload runs only while this app is open; interrupted downloads resume on next launch.</small>
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
      data-testid="offline-sync-now"
      :disabled="busy"
      @click="syncNow"
    >
      {{ t('offline.syncNow') }}
    </button>
    <button
      v-if="active !== null && canExport"
      type="button"
      data-testid="offline-export-pending"
      :disabled="busy"
      @click="exportPending"
    >
      {{ t('offline.exportPending') }}
    </button>
    <p v-if="exportResult" data-testid="offline-export-result" role="status">{{ exportResult }}</p>
    <section v-if="api.resumeNativeTransfers">
      <button type="button" data-testid="native-transfer-resume" :disabled="busy" @click="resumeNative">Resume supported queued edits and images</button>
      <small>Android schedules network-constrained work. Dependency-held edits wait for their predecessors. Unsupported plugins, capabilities and oversized images require foreground Update. Update verifies server receipts and the offline copy before removing pending work.</small>
      <p v-if="nativeStatus" role="status">{{ nativeStatus }}</p>
    </section>
    <section v-if="canRestore" class="pending-work-restore">
      <strong>Restore pending work</strong>
      <small>Restore an exported pending-work file on this same device and library. This does not replace your library. Nothing is sent automatically.</small>
      <label>Pending-work file
        <input type="file" accept="application/json,.json" data-testid="offline-restore-file" :disabled="busy" @change="selectRestoreFile" />
      </label>
      <p v-if="restorePreview" data-testid="offline-restore-preview">
        {{ restorePreview.operationCount }} edits · {{ restorePreview.mediaCount }} images · {{ restorePreview.binaryBytes }} bytes.
        {{ restorePreview.scope }}. Adds {{ restorePreview.addedOperations }} edits and {{ restorePreview.addedMedia }} images to your existing pending work; identical live work stays unchanged.
      </p>
      <button v-if="restorePreview" type="button" data-testid="offline-restore-confirm" :disabled="busy" @click="confirmRestore">Confirm restore into pending work</button>
      <p v-if="restoreIssue" role="alert" data-testid="offline-restore-error">{{ restoreIssue }}</p>
      <p v-if="restoreResult" role="status" data-testid="offline-restore-result">{{ restoreResult }}</p>
    </section>
    <button
      v-if="active !== null"
      type="button"
      data-testid="offline-clear"
      :disabled="busy"
      @click="clearOffline"
    >
      {{ t('offline.clear') }}
    </button>
    <small v-if="contentSupport" data-testid="offline-content-support">{{ contentSupport }}</small>
    <button
      v-if="active !== null"
      type="button"
      data-testid="offline-check-support"
      :disabled="busy || !online"
      @click="checkEditingSupport"
    >
      {{ t('offline.checkSupport') }}
    </button>
    <small v-if="storageStatus" data-testid="offline-storage-status">{{ storageStatus }} · {{ persistenceStatus }}</small>
    <button
      v-if="canRequestPersistence"
      type="button"
      data-testid="offline-request-persistence"
      :disabled="busy"
      @click="requestPersistence"
    >{{ t('offline.requestPersistence') }}</button>
    <small>{{ t('offline.hint') }}</small>
    <small v-if="mediaStatus" data-testid="offline-media-status">{{ mediaStatus }}</small>
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
