<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { GalleryApi, PendingOfflineEntryCreate } from '../api/gallery.js';
import { useI18n } from '../i18n.js';
type Row = { syncUid: string; contentType: string; content: string; sortOrder: number };
const props = defineProps<{ api: GalleryApi; entry: PendingOfflineEntryCreate;
  saveContents: (key: string, desired: Row[]) => Promise<void> }>();
const emit = defineEmits<{ saved: [desired: Row[]]; cancel: [] }>();
const { t } = useI18n();
const rows = ref<Row[]>([]);
const baseline = ref<Row[]>([]);
const loaded = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const removing = ref<string | null>(null);
let alive = true;
let committed = false;
onBeforeUnmount(() => { alive = false; });
const writable = computed(() => props.entry.status === 'pending' && props.entry.canEditContents === true);
const desired = computed(() => rows.value.map(row => ({ ...row, contentType: row.contentType.trim() })));
const valid = computed(() => desired.value.every(row => row.contentType.length > 0 && row.content.trim().length > 0));
const changed = computed(() => JSON.stringify(desired.value) !== JSON.stringify(baseline.value));
onMounted(async () => {
  if (!writable.value || !props.api.getPendingOfflineEntryContentOptions) { error.value = t('search.pendingContentsUnavailable'); return; }
  try {
    const options = await props.api.getPendingOfflineEntryContentOptions(props.entry.localKey);
    if (!alive) return;
    baseline.value = options.contents.map(row => ({ ...row }));
    rows.value = options.contents.map(row => ({ ...row }));
    loaded.value = true;
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingContentsError'); }
});
function remove(): void {
  if (saving.value || !writable.value || removing.value === null) return;
  rows.value = rows.value.filter(row => row.syncUid !== removing.value);
  removing.value = null;
}
async function save(): Promise<void> {
  if (committed || saving.value || !loaded.value || !writable.value || !valid.value || !changed.value || removing.value !== null) return;
  const copied = desired.value.map(row => ({ ...row }));
  saving.value = true; error.value = null;
  try {
    await props.saveContents(props.entry.localKey, copied);
    committed = true;
    if (alive) emit('saved', copied);
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('search.pendingContentsError');
  } finally { if (!committed) saving.value = false; }
}
</script>
<template>
  <section class="pending-contents-editor">
    <p v-if="error" role="alert" data-testid="pending-contents-error">{{ error }}</p>
    <p v-if="!writable" role="alert">{{ t('search.pendingContentsUnavailable') }}</p>
    <form v-else-if="loaded" data-testid="pending-contents-form" @submit.prevent="save">
      <fieldset v-for="row in rows" :key="row.syncUid" :disabled="saving">
        <label>{{ t('search.pendingContentType') }}<input v-model="row.contentType" :data-testid="`pending-content-type-${row.syncUid}`" required></label>
        <label>{{ t('search.pendingContentText') }}<textarea v-model="row.content" :data-testid="`pending-content-text-${row.syncUid}`" required /></label>
        <button type="button" class="secondary-button" :data-testid="`pending-content-remove-${row.syncUid}`" @click="removing = row.syncUid">{{ t('search.pendingRemoveContent') }}</button>
        <div v-if="removing === row.syncUid" class="pending-contents-actions">
          <span>{{ t('search.pendingConfirmRemoveContent') }}</span>
          <button type="button" class="secondary-button" data-testid="pending-content-confirm-remove" @click="remove">{{ t('search.pendingConfirmRemove') }}</button>
          <button type="button" class="secondary-button" data-testid="pending-content-cancel-remove" @click="removing = null">{{ t('search.pendingCancelTags') }}</button>
        </div>
      </fieldset>
      <p v-if="rows.length === 0" data-testid="pending-contents-empty">{{ t('search.pendingContentsEmpty') }}</p>
      <p v-if="!valid" role="alert">{{ t('search.pendingContentsInvalid') }}</p>
      <div class="pending-contents-actions">
        <button type="submit" class="primary-button" :disabled="saving || !valid || !changed || removing !== null">{{ t('search.pendingSaveContents') }}</button>
        <button type="button" class="secondary-button" :disabled="saving" @click="emit('cancel')">{{ t('search.pendingCancelTags') }}</button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.pending-contents-editor form, .pending-contents-editor fieldset, .pending-contents-editor label { display: grid; gap: 0.5rem; }
.pending-contents-editor form { margin-block: 0.5rem; }
.pending-contents-editor fieldset { min-width: 0; }
.pending-contents-editor input, .pending-contents-editor textarea { width: 100%; min-width: 0; box-sizing: border-box; }
.pending-contents-editor input, .pending-contents-editor button { min-height: 44px; min-width: 44px; }
.pending-contents-editor textarea { min-height: 6rem; resize: vertical; }
.pending-contents-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
</style>
