<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { GalleryApi } from '../api/gallery.js';
import { cacheSnapshotMedia, mediaRefsToRevalidate } from '../offline/offline-media.js';
import { clearOfflineSnapshot, downloadOfflineSnapshot } from '../offline/offline-sync.js';
import { OFFLINE_MEDIA_CACHE } from '../offline/cache-names.js';
import { cachedMediaObjectUrls } from '../offline/cached-media-object-urls.js';
import { readActiveSnapshot, type ActiveSnapshot, type SnapshotStore } from '../offline/snapshot-store.js';
import { useI18n } from '../i18n.js';

const props = defineProps<{
  api: Pick<GalleryApi, 'assetUrl' | 'getSyncCapabilities' | 'fetchSyncSnapshot'>;
  store: SnapshotStore;
}>();

const { t } = useI18n();
const active = ref<ActiveSnapshot | null>(null);
const busy = ref(false);
const issue = ref<string | null>(null);
const mediaStatus = ref<string | null>(null);

const status = computed(() => {
  if (issue.value !== null) return t('offline.error', { detail: issue.value });
  if (active.value === null) return t('offline.empty');
  const count = active.value.snapshot.header.counts.entries;
  return t(count === 1 ? 'offline.readyOne' : 'offline.ready', {
    count,
    sequence: active.value.snapshot.header.snapshotSeq,
  });
});

async function refreshStatus(): Promise<void> {
  try {
    active.value = await readActiveSnapshot(props.store);
  } catch (cause) {
    issue.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function download(): Promise<void> {
  busy.value = true;
  issue.value = null;
  try {
    const previousSnapshot = active.value?.snapshot ?? null;
    const result = await downloadOfflineSnapshot({ api: props.api, store: props.store });
    if (!result.ok) {
      issue.value = t(`offline.failure.${result.reason}`, { detail: result.detail });
      return;
    }
    active.value = result.active;
    if (typeof globalThis.caches === 'undefined') {
      mediaStatus.value = t('offline.mediaUnavailable');
      return;
    }
    try {
      const mediaRefs = result.active.snapshot.payload.mediaRefs;
      const media = await cacheSnapshotMedia(result.active.snapshot.payload.mediaRefs, {
        assetUrl: props.api.assetUrl,
        cacheStorage: globalThis.caches,
        revalidateRefs: mediaRefsToRevalidate(previousSnapshot, result.active.snapshot),
        onProgress(progress) {
          mediaStatus.value = t('offline.mediaProgress', {
            processed: progress.processed,
            total: progress.total,
          });
        },
      });
      cachedMediaObjectUrls.clear();
      mediaStatus.value = t('offline.mediaResult', {
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
    await clearOfflineSnapshot(props.store);
    if (typeof globalThis.caches !== 'undefined') {
      await globalThis.caches.delete(OFFLINE_MEDIA_CACHE);
    }
    cachedMediaObjectUrls.clear();
    active.value = null;
    mediaStatus.value = null;
  } catch (cause) {
    issue.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void refreshStatus());
</script>

<template>
  <section class="offline-settings" data-testid="offline-settings">
    <div>
      <strong>{{ t('offline.title') }}</strong>
      <p data-testid="offline-status">{{ status }}</p>
    </div>
    <button
      type="button"
      data-testid="offline-download"
      :disabled="busy"
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
  </section>
</template>

<style scoped>
.offline-settings {
  display: grid;
  gap: 0.55rem;
  margin-top: 0.9rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--border-subtle);
}
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
