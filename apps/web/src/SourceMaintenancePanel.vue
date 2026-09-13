<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type {
  SourceLibraryRecordDto,
  SourceMaintenanceItemRecordDto,
  SourceMaintenanceRunRecordDto,
} from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import { useI18n } from './i18n.js';
import { useArmableAction } from './armable.js';

/**
 * Advanced → Source maintenance wizard (plan §15). Origin → target probe →
 * resumable search job → per-item review → explicit two-click commit. The
 * panel never deletes or hides old URLs: an invalid origin is only a badge.
 */
const props = defineProps<{ api: GalleryApi }>();
const emit = defineEmits<{ 'works-changed': [] }>();
const { t } = useI18n();
const { armedKey, arm, disarm } = useArmableAction();

const sources = ref<SourceLibraryRecordDto[]>([]);
const selectedSourceKey = ref<string | null>(null);
const markOriginInvalid = ref(false);
const homepage = ref('');
const probe = ref<{
  ok: boolean;
  adapterKey?: string;
  displayName?: string;
  origin?: string;
  detail?: string;
} | null>(null);
const run = ref<SourceMaintenanceRunRecordDto | null>(null);
const items = ref<SourceMaintenanceItemRecordDto[]>([]);
const itemTotal = ref(0);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref('');
const manualUrls = ref<Record<number, string>>({});
let pollTimer: ReturnType<typeof setInterval> | null = null;

type BandLabelKey = 'sm.bandExactSafe' | 'sm.bandStrongReview' | 'sm.bandAmbiguous'
  | 'sm.bandConflict' | 'sm.bandNoMatch' | 'sm.bandError';

const bandLabels: Record<string, BandLabelKey> = {
  'exact-safe': 'sm.bandExactSafe',
  'strong-review': 'sm.bandStrongReview',
  'ambiguous': 'sm.bandAmbiguous',
  'conflict': 'sm.bandConflict',
  'no-match': 'sm.bandNoMatch',
  'error': 'sm.bandError',
};

function bandLabel(band: string): string {
  const key = bandLabels[band];
  return key === undefined ? band : t(key);
}

const selectedSource = computed(() => (
  sources.value.find((source) => source.sourceKey === selectedSourceKey.value) ?? null
));

const runActive = computed(() => (
  run.value !== null && (run.value.status === 'running' || run.value.status === 'paused')
));

async function loadSources(): Promise<void> {
  try {
    sources.value = await props.api.listSourceLibrary();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

onMounted(loadSources);
onBeforeUnmount(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
});

async function probeTarget(): Promise<void> {
  if (homepage.value.trim() === '') return;
  busy.value = true;
  error.value = null;
  probe.value = null;
  try {
    probe.value = await props.api.probeSourceTarget(homepage.value.trim());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function refreshRun(): Promise<void> {
  if (run.value === null) return;
  try {
    run.value = await props.api.getSourceMaintenanceRun(run.value.id);
    const page = await props.api.listSourceMaintenanceItems(run.value.id, { page: 1, pageSize: 100 });
    items.value = page.items;
    itemTotal.value = page.total;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function startPolling(): void {
  if (pollTimer === null) {
    pollTimer = setInterval(() => {
      void refreshRun();
    }, 1500);
  }
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function startRun(): Promise<void> {
  if (selectedSourceKey.value === null || probe.value?.ok !== true) return;
  busy.value = true;
  error.value = null;
  try {
    run.value = await props.api.createSourceMaintenanceRun({
      originSourceKey: selectedSourceKey.value,
      adapterKey: probe.value?.adapterKey ?? '',
      targetHomepage: homepage.value.trim(),
      markOriginInvalid: markOriginInvalid.value,
    });
    run.value = await props.api.startSourceMaintenanceRun(run.value.id);
    await refreshRun();
    startPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function control(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  if (run.value === null) return;
  busy.value = true;
  try {
    run.value = action === 'pause'
      ? await props.api.pauseSourceMaintenanceRun(run.value.id)
      : action === 'resume'
        ? await props.api.resumeSourceMaintenanceRun(run.value.id)
        : await props.api.cancelSourceMaintenanceRun(run.value.id);
    if (action === 'cancel') stopPolling();
    await refreshRun();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function setDecision(
  item: SourceMaintenanceItemRecordDto,
  decision: 'accept' | 'skip',
  selectedUrl?: string | null,
): Promise<void> {
  try {
    await props.api.patchSourceMaintenanceItem(run.value!.id, item.entryId, {
      decision,
      ...(selectedUrl === undefined ? {} : { selectedUrl }),
    });
    await refreshRun();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function commit(): Promise<void> {
  if (run.value === null) return;
  if (!arm('sm-commit')) return;
  disarm('sm-commit');
  busy.value = true;
  try {
    const result = await props.api.commitSourceMaintenanceRun(run.value.id);
    notice.value = t('sm.committed', {
      created: result.createdCount,
      skipped: result.skippedCount,
      unresolved: result.unresolvedCount,
    });
    stopPolling();
    await Promise.all([refreshRun(), loadSources()]);
    emit('works-changed');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section data-testid="source-maintenance" class="advanced-card">
    <h3>{{ t('sm.title') }}</h3>
    <p class="muted">{{ t('sm.hint') }}</p>

    <div class="sm-origin">
      <h4>{{ t('sm.origin') }}</h4>
      <p v-if="sources.length === 0" class="muted">{{ t('sm.noSources') }}</p>
      <ul class="sm-source-list">
        <li v-for="source in sources" :key="source.sourceKey">
          <label>
            <input
              type="radio"
              name="sm-origin-source"
              :checked="selectedSourceKey === source.sourceKey"
              @change="selectedSourceKey = source.sourceKey"
            >
            <strong>{{ source.sourceName }}</strong>
            <span class="muted">{{ source.hosts.join(', ') }}</span>
            <span class="muted">{{ t('sm.sourceCount', { entries: source.entryCount }) }}</span>
            <span
              class="sm-state-badge"
              :class="{ 'sm-state-badge--invalid': source.state === 'invalid' }"
            >{{ source.state === 'invalid' ? t('sm.stateInvalid') : t('sm.stateActive') }}</span>
          </label>
        </li>
      </ul>
      <label class="sm-inline">
        <input v-model="markOriginInvalid" type="checkbox">
        {{ t('sm.markInvalid') }}
      </label>
      <p class="muted">{{ t('sm.markInvalidHint') }}</p>
    </div>

    <div class="sm-target">
      <h4>{{ t('sm.target') }}</h4>
      <label class="sm-inline">
        <input
          v-model="homepage"
          type="text"
          data-testid="sm-target-homepage"
          :placeholder="t('sm.targetPlaceholder')"
        >
        <button type="button" class="secondary-button" :disabled="busy" @click="probeTarget">
          {{ t('sm.probe') }}
        </button>
      </label>
      <p v-if="probe?.ok" class="sm-probe-ok">{{ t('sm.probeOk', { name: probe.displayName ?? '' }) }}</p>
      <p v-else-if="probe && !probe.ok" class="sm-probe-fail">{{ t('sm.probeFail', { detail: probe.detail ?? '' }) }}</p>
      <button
        type="button"
        class="primary-button"
        data-testid="sm-start"
        :disabled="busy || selectedSourceKey === null || probe?.ok !== true"
        @click="startRun"
      >
        {{ t('sm.start') }}
      </button>
    </div>

    <div v-if="run" class="sm-job" data-testid="sm-job">
      <h4>{{ t('sm.job') }}</h4>
      <p>
        {{ t('sm.status', { status: run.status }) }}
        {{ t('sm.counts', {
          processed: run.counts.processed,
          matched: run.counts.matched,
          ambiguous: run.counts.ambiguous,
          noMatch: run.counts.noMatch,
          errors: run.counts.errors,
          total: run.counts.total,
        }) }}
      </p>
      <div class="sm-job-actions">
        <button v-if="run.status === 'running' || run.status === 'draft'" type="button" :disabled="busy" @click="control('pause')">{{ t('sm.pause') }}</button>
        <button v-if="run.status === 'paused'" type="button" :disabled="busy" @click="control('resume')">{{ t('sm.resume') }}</button>
        <button v-if="run.status !== 'committed' && run.status !== 'cancelled'" type="button" :disabled="busy" @click="control('cancel')">{{ t('sm.cancel') }}</button>
      </div>
    </div>

    <div v-if="items.length > 0" class="sm-review" data-testid="sm-review">
      <h4>{{ t('sm.review') }}</h4>
      <div
        v-for="item in items"
        :key="item.entryId"
        class="sm-item"
        :data-sm-entry-id="item.entryId"
      >
        <header>
          <strong>{{ item.entryTitleSnapshot }}</strong>
          <span class="muted">{{ item.originUrls.join(', ') }}</span>
        </header>
        <p v-if="item.errorText" class="sm-probe-fail">{{ item.errorText }}</p>
        <p v-else-if="item.candidates.length === 0" class="muted">{{ t('sm.noCandidates') }}</p>
        <ul v-else class="sm-candidates">
          <li v-for="candidate in item.candidates" :key="candidate.url">
            <label class="sm-inline">
              <input
                type="radio"
                :name="`sm-candidate-${item.entryId}`"
                :checked="item.selectedUrl === candidate.url"
                @change="setDecision(item, 'accept', candidate.url)"
              >
              <span class="sm-band" :data-band="candidate.band">{{ bandLabel(candidate.band) }}</span>
              <strong>{{ candidate.title }}</strong>
              <span class="muted">{{ candidate.url }}</span>
            </label>
            <p class="sm-reasons">{{ candidate.reasons.join(' · ') }}</p>
          </li>
        </ul>
        <div class="sm-item-actions">
          <label class="sm-inline">
            <input
              v-model="manualUrls[item.entryId]"
              type="text"
              :placeholder="t('sm.manualUrl')"
            >
            <button
              type="button"
              :disabled="!manualUrls[item.entryId]"
              @click="setDecision(item, 'accept', manualUrls[item.entryId])"
            >{{ t('sm.manualAccept') }}</button>
          </label>
          <button type="button" :disabled="busy" @click="setDecision(item, 'skip')">{{ t('sm.skip') }}</button>
        </div>
      </div>
    </div>

    <div v-if="run" class="sm-commit">
      <button
        type="button"
        class="primary-button"
        :class="{ 'armable-armed': armedKey === 'sm-commit' }"
        :disabled="busy || run.status !== 'review'"
        @click="commit"
      >
        {{ armedKey === 'sm-commit' ? t('sm.commitConfirm') : t('sm.commit') }}
      </button>
      <p v-if="notice" class="sm-notice">{{ notice }}</p>
    </div>
  </section>
</template>

<style scoped>
.sm-origin, .sm-target, .sm-job, .sm-review, .sm-commit { margin-top: 0.8rem; }
.sm-source-list { list-style: none; margin: 0.3rem 0; padding: 0; }
.sm-source-list label { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.2rem 0; }
.sm-state-badge { padding: 0 0.4rem; border-radius: 0.4rem; background: var(--surface-muted); font-size: 0.75rem; }
.sm-state-badge--invalid { color: #b91c1c; }
.sm-inline { display: inline-flex; align-items: center; gap: 0.4rem; }
.sm-probe-ok { color: #15803d; }
.sm-probe-fail { color: #b91c1c; }
.sm-candidates { list-style: none; margin: 0.3rem 0; padding: 0; }
.sm-candidates li { padding: 0.2rem 0; }
.sm-band { padding: 0 0.4rem; border-radius: 0.4rem; background: var(--surface-muted); font-size: 0.75rem; }
.sm-band[data-band='exact-safe'] { color: #15803d; }
.sm-band[data-band='conflict'] { color: #b91c1c; }
.sm-reasons { margin: 0.1rem 0 0.3rem 1.5rem; color: var(--text-muted); font-size: 0.78rem; }
.sm-item { border-top: 1px solid var(--border-subtle); padding: 0.5rem 0; }
.sm-item-actions { display: flex; gap: 0.6rem; align-items: center; }
.sm-notice { color: #15803d; }
</style>
