<script setup lang="ts">
// A work's page count and date, in the one row that shows and edits them.
//
// It lives in a component because it has two positions: inside the header of the "Basic
// Information" Section on the work types that have one (where these two have always been shown),
// and as its own row at the top of the information board on the types that do not — a work's date
// and page count are facts about the work, not about a Section, so a missing Section must not make
// them unreachable. One definition, so the two positions cannot drift.
//
// Editing copies the title's own gesture: double-click the value on a device with a pointer, one tap
// on a touch screen, Enter to save, Esc to cancel, blur to save. Nothing is added to the board.
import { computed, nextTick, onMounted, ref } from 'vue';

import { formatDuration, parseDurationSeconds } from '@t3/shared';

import type { GalleryApi } from '../api/gallery.js';
import { useI18n } from '../i18n.js';
import { touchOnlyDevice } from '../touch.js';

const props = defineProps<{
  api: GalleryApi;
  entryId: number;
  pageCount: number | null;
  /** A video's runtime in seconds; shown as `h:mm:ss`, and its peer for a work with no pages. */
  durationSeconds?: number | null | undefined;
  uploadDate: string | null;
  /** Whether the Entry is being edited at all. */
  editing: boolean;
  /** "Show empty facets": the same switch that reveals empty Facets reveals these. */
  showEmpty: boolean;
}>();

const emit = defineEmits<{ saved: [] }>();

const { t } = useI18n();

/** A work's date may be a year, a year and month, or a full date — and nothing else. */
const DATE_PREFIX_PATTERN = /^\d{4}(-\d{2})?(-\d{2})?$/u;

const pageCountEditorOpen = ref(false);
const pageCountDraft = ref<string | number>('');
const durationEditorOpen = ref(false);
const durationDraft = ref('');
const uploadDateEditorOpen = ref(false);
const uploadDateDraft = ref('');
const saving = ref(false);
const pageCountInput = ref<HTMLInputElement | null>(null);
const durationInput = ref<HTMLInputElement | null>(null);
const uploadDateInput = ref<HTMLInputElement | null>(null);
const touchOnly = ref(false);
const error = ref<string | null>(null);

/** Show the row at all: a value to show, or the switch is on and we are editing. */
const visible = computed(() => (
  props.pageCount !== null
  || props.durationSeconds !== null && props.durationSeconds !== undefined
  || props.uploadDate !== null
  || (props.editing && props.showEmpty)
));
const showPageCount = computed(() => props.pageCount !== null || (props.editing && props.showEmpty));
const showDuration = computed(() => (
  props.durationSeconds !== null && props.durationSeconds !== undefined
) || (props.editing && props.showEmpty));
const showUploadDate = computed(() => props.uploadDate !== null || (props.editing && props.showEmpty));

onMounted(() => {
  touchOnly.value = touchOnlyDevice();
});

function beginPageCountEdit(): void {
  if (!props.editing || saving.value) return;
  error.value = null;
  pageCountDraft.value = props.pageCount === null ? '' : String(props.pageCount);
  pageCountEditorOpen.value = true;
  void nextTick(() => {
    pageCountInput.value?.focus();
    pageCountInput.value?.select();
  });
}

function cancelPageCountEdit(): void {
  pageCountEditorOpen.value = false;
  pageCountDraft.value = '';
}

async function savePageCount(): Promise<void> {
  if (!pageCountEditorOpen.value) return;
  // `type="number"` casts what `v-model` reads to a number, so the draft is normalised before it is
  // read — a `.trim()` on the raw value throws, and an exception in a handler is invisible.
  const raw = String(pageCountDraft.value).trim();
  const next = raw === '' ? null : Number(raw);
  if (next !== null && (!Number.isInteger(next) || next < 0)) {
    cancelPageCountEdit();
    return;
  }
  if (next === null || next === props.pageCount) {
    // An empty box means "no change": an update cannot unset a page count (the field is optional,
    // not nullable), so offering to clear it would be a promise the API cannot keep.
    cancelPageCountEdit();
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await props.api.updateEntry(props.entryId, { pageCount: next });
    cancelPageCountEdit();
    emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateEntry');
  } finally {
    saving.value = false;
  }
}

function beginDurationEdit(): void {
  if (!props.editing || saving.value) return;
  error.value = null;
  durationDraft.value = formatDuration(props.durationSeconds);
  durationEditorOpen.value = true;
  void nextTick(() => {
    durationInput.value?.focus();
    durationInput.value?.select();
  });
}

function cancelDurationEdit(): void {
  durationEditorOpen.value = false;
  durationDraft.value = '';
}

async function saveDuration(): Promise<void> {
  if (!durationEditorOpen.value) return;
  const raw = durationDraft.value.trim();
  // An empty box clears it, the way the date's does: a runtime is nullable, so a value typed by
  // mistake has to be removable. A box holding something unreadable keeps the editor open with the
  // reason, rather than storing a number nobody can explain.
  const next = raw === '' ? null : parseDurationSeconds(raw);
  if (raw !== '' && next === null) {
    error.value = t('error.durationFormat');
    durationInput.value?.focus();
    return;
  }
  if (next === (props.durationSeconds ?? null)) {
    cancelDurationEdit();
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await props.api.updateEntry(props.entryId, { durationSeconds: next });
    cancelDurationEdit();
    emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateEntry');
  } finally {
    saving.value = false;
  }
}

function beginUploadDateEdit(): void {
  if (!props.editing || saving.value) return;
  error.value = null;
  uploadDateDraft.value = props.uploadDate ?? '';
  uploadDateEditorOpen.value = true;
  void nextTick(() => {
    uploadDateInput.value?.focus();
    uploadDateInput.value?.select();
  });
}

function cancelUploadDateEdit(): void {
  uploadDateEditorOpen.value = false;
  uploadDateDraft.value = '';
}

async function saveUploadDate(): Promise<void> {
  if (!uploadDateEditorOpen.value) return;
  const raw = uploadDateDraft.value.trim();
  // The three shapes a date may take. Anything else keeps the editor open with the reason, rather
  // than storing a value that cannot sort or display alongside the others.
  if (raw !== '' && !DATE_PREFIX_PATTERN.test(raw)) {
    error.value = t('error.uploadDateFormat');
    uploadDateInput.value?.focus();
    return;
  }
  const next = raw === '' ? null : raw;
  if (next === (props.uploadDate ?? null)) {
    cancelUploadDateEdit();
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await props.api.updateEntry(props.entryId, { uploadDate: next });
    cancelUploadDateEdit();
    emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateEntry');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <span v-if="visible" class="information-stats" data-testid="entry-stats-row">
    <span v-if="showPageCount" class="information-stat">
      <input
        v-if="pageCountEditorOpen"
        ref="pageCountInput"
        v-model="pageCountDraft"
        class="information-stat-input"
        data-testid="page-count-input"
        type="number"
        min="1"
        step="1"
        :aria-label="t('entry.pageCountLabel')"
        @keydown.enter.prevent="savePageCount"
        @keydown.esc.prevent="cancelPageCountEdit"
        @blur="savePageCount"
      >
      <span
        v-else-if="pageCount !== null"
        class="information-stat-value"
        :class="{ 'information-stat-editable': editing }"
        data-testid="page-count-value"
        :title="editing ? t('entry.inlineEditHint') : undefined"
        @dblclick="beginPageCountEdit"
        @click="touchOnly && beginPageCountEdit()"
      >{{ t('entry.pageCount', { count: pageCount }) }}</span>
      <button
        v-else
        type="button"
        class="add-button add-stat-button"
        data-testid="add-page-count"
        @click="beginPageCountEdit"
      >{{ t('entry.addPages') }}</button>
    </span>
    <span v-if="showDuration" class="information-stat">
      <input
        v-if="durationEditorOpen"
        ref="durationInput"
        v-model="durationDraft"
        class="information-stat-input"
        data-testid="duration-input"
        autocomplete="off"
        placeholder="h:mm:ss"
        :aria-label="t('entry.durationLabel')"
        @keydown.enter.prevent="saveDuration"
        @keydown.esc.prevent="cancelDurationEdit"
        @blur="saveDuration"
      >
      <span
        v-else-if="durationSeconds !== null && durationSeconds !== undefined"
        class="information-stat-value"
        :class="{ 'information-stat-editable': editing }"
        data-testid="duration-value"
        :title="editing ? t('entry.inlineEditHint') : undefined"
        @dblclick="beginDurationEdit"
        @click="touchOnly && beginDurationEdit()"
      >{{ t('entry.duration', { duration: formatDuration(durationSeconds) }) }}</span>
      <button
        v-else
        type="button"
        class="add-button add-stat-button"
        data-testid="add-duration"
        @click="beginDurationEdit"
      >{{ t('entry.addDuration') }}</button>
    </span>
    <span v-if="showUploadDate" class="information-stat">
      <input
        v-if="uploadDateEditorOpen"
        ref="uploadDateInput"
        v-model="uploadDateDraft"
        class="information-stat-input"
        data-testid="upload-date-input"
        autocomplete="off"
        placeholder="yyyy-mm-dd"
        :aria-label="t('entry.uploadDateLabel')"
        @keydown.enter.prevent="saveUploadDate"
        @keydown.esc.prevent="cancelUploadDateEdit"
        @blur="saveUploadDate"
      >
      <span
        v-else-if="uploadDate"
        class="information-stat-value"
        :class="{ 'information-stat-editable': editing }"
        data-testid="upload-date-value"
        :title="editing ? t('entry.inlineEditHint') : undefined"
        @dblclick="beginUploadDateEdit"
        @click="touchOnly && beginUploadDateEdit()"
      >{{ t('entry.uploadDate', { date: uploadDate }) }}</span>
      <button
        v-else
        type="button"
        class="add-button add-stat-button"
        data-testid="add-upload-date"
        @click="beginUploadDateEdit"
      >{{ t('entry.addDate') }}</button>
    </span>
    <span v-if="error" class="information-stat-error" role="alert">{{ error }}</span>
  </span>
</template>

<style scoped>
.information-stat { color: var(--text-muted); font-size: 0.78rem; }
.information-stat-editable { cursor: text; }
.information-stat-editable:hover { color: var(--text-primary); }
.information-stat-input { width: 10rem; padding: 0.25rem 0.45rem; border: 1px solid var(--accent); border-radius: 0.45rem; color: var(--text-primary); background: var(--surface); font: inherit; font-size: 0.78rem; }
.information-stat-input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 18%, transparent); }
.add-stat-button { padding: 0.2rem 0.5rem; border-radius: 999px; font-size: 0.72rem; }
.information-stat-error { color: var(--danger, #b3261e); font-size: 0.78rem; }
</style>
