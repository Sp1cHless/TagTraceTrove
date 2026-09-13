<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { normalizeTag } from '@t3/shared';
import type { RelationSuggestion } from '@t3/shared';
import { useI18n } from '../i18n.js';

/**
 * Relation autocomplete for editing surfaces. Candidate eligibility and
 * ordering live on the server (`/api/suggestions/*`); this component only
 * owns the interaction contract: debounced requests, stale-response
 * dropping, IME safety, keyboard navigation, and a blur that closes the
 * dropdown without ever committing anything.
 */
const props = defineProps<{
  mode: 'creatable-text' | 'id-only';
  provider: (
    query: string,
    excludeIds: number[],
    signal: AbortSignal,
  ) => Promise<RelationSuggestion[]>;
  /** Server-side exclusions; already-bound relations must not consume the result budget. */
  excludeIds?: number[];
  placeholder?: string;
  ariaLabel?: string;
  /** DOM name for the input so surrounding forms and tests can address it. */
  name?: string;
  /**
   * Tag-creation editors keep the old tap-elsewhere-to-save flow: blur
   * commits the typed text (never a highlighted candidate). Author linking
   * stays blur-closes-only so an accidental click can never link.
   */
  commitOnBlur?: boolean;
  /**
   * Fill-in mode for merge/alias forms: choosing a candidate writes its name
   * into the field (the parent records it through the select event) instead
   * of clearing the editor.
   */
  selectFillsInput?: boolean;
  /** Override only for tests; the shipped interaction contract is 150ms. */
  debounceMs?: number;
}>();

const emit = defineEmits<{
  select: [suggestion: RelationSuggestion];
  'submit-text': [text: string];
}>();

const { t } = useI18n();

const DEBOUNCE_MS = props.debounceMs ?? 150;

const rawQuery = ref('');
const focused = ref(false);
const composing = ref(false);
const closed = ref(false);
const loading = ref(false);
const suggestions = ref<RelationSuggestion[]>([]);
const highlightIndex = ref(-1);
const listId = useId();

const activeQuery = computed(() => normalizeTag(rawQuery.value));
// The editor input stays short and grows with the typed text (counted in
// code points, not UTF-16 units); the dropdown is absolutely positioned and
// therefore can never stretch it.
const inputSize = computed(() => Math.max(5, Array.from(rawQuery.value).length));
const dropdownOpen = computed(() => (
  focused.value && !closed.value && activeQuery.value !== ''
));

let requestGeneration = 0;
let debounceHandle: ReturnType<typeof setTimeout> | null = null;
let activeController: AbortController | null = null;
let lastLoadedQuery: string | null = null;

function clearPendingDebounce(): void {
  if (debounceHandle === null) return;
  clearTimeout(debounceHandle);
  debounceHandle = null;
}

function resetResults(): void {
  suggestions.value = [];
  highlightIndex.value = -1;
  lastLoadedQuery = null;
  loading.value = false;
  requestGeneration += 1;
  activeController?.abort();
  activeController = null;
}

function scheduleSearch(): void {
  clearPendingDebounce();
  if (activeQuery.value === '') {
    resetResults();
    return;
  }
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    void runSearch();
  }, DEBOUNCE_MS);
}

async function runSearch(): Promise<void> {
  const query = activeQuery.value;
  if (query === '') return;
  const generation = requestGeneration + 1;
  requestGeneration = generation;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  loading.value = true;
  try {
    const results = await props.provider(query, props.excludeIds ?? [], controller.signal);
    if (generation !== requestGeneration) return;
    suggestions.value = results;
    highlightIndex.value = -1;
    lastLoadedQuery = query;
  } catch {
    // Late or failed responses degrade to "no matches"; they never submit.
    if (generation !== requestGeneration) return;
    suggestions.value = [];
    highlightIndex.value = -1;
    lastLoadedQuery = query;
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

watch(activeQuery, () => {
  closed.value = false;
  if (composing.value) return;
  scheduleSearch();
});

watch(() => props.excludeIds, () => {
  if (activeQuery.value === '' || composing.value) return;
  // Keep server-side exclusions authoritative over the 20-item budget.
  clearPendingDebounce();
  void runSearch();
}, { deep: true });

function onCompositionStart(): void {
  composing.value = true;
  clearPendingDebounce();
}

function onCompositionEnd(): void {
  composing.value = false;
  scheduleSearch();
}

function onFocus(): void {
  focused.value = true;
  closed.value = false;
  if (activeQuery.value === '') return;
  if (lastLoadedQuery !== activeQuery.value && suggestions.value.length === 0) {
    scheduleSearch();
  }
}

function onBlur(): void {
  if (props.commitOnBlur && props.mode === 'creatable-text' && !composing.value) {
    const text = rawQuery.value.trim();
    if (props.selectFillsInput) {
      // Fill-in editors (alias / merge forms) keep what was typed: the field is
      // the visible record of the value the form will save, so clearing it on
      // blur reads as "my input was lost". An emptied field clears the value.
      rawQuery.value = text;
      closed.value = true;
      suggestions.value = [];
      highlightIndex.value = -1;
      focused.value = false;
      if (normalizeTag(text) !== '') emit('submit-text', text);
      else if (text === '') emit('submit-text', '');
      return;
    }
    if (normalizeTag(text) !== '') {
      emit('submit-text', text);
      afterChoice();
      return;
    }
  }
  // Otherwise blur only closes; committing is an explicit Enter or click.
  focused.value = false;
}

function moveHighlight(delta: 1 | -1): void {
  if (!dropdownOpen.value || suggestions.value.length === 0) return;
  const maxIndex = suggestions.value.length - 1;
  const next = highlightIndex.value + delta;
  highlightIndex.value = next < -1 ? -1 : next > maxIndex ? maxIndex : next;
}

function afterChoice(): void {
  rawQuery.value = '';
  suggestions.value = [];
  highlightIndex.value = -1;
  closed.value = false;
  lastLoadedQuery = null;
}

function choose(suggestion: RelationSuggestion): void {
  if (props.selectFillsInput) {
    rawQuery.value = suggestion.name;
    closed.value = true;
    highlightIndex.value = -1;
    emit('select', suggestion);
    return;
  }
  emit('select', suggestion);
  afterChoice();
}

function onEnter(event: KeyboardEvent): void {
  event.preventDefault();
  if (composing.value) return;
  if (dropdownOpen.value) {
    const highlighted = suggestions.value[highlightIndex.value];
    if (highlighted) {
      choose(highlighted);
      return;
    }
  }
  if (props.mode !== 'creatable-text') return;
  const text = rawQuery.value.trim();
  if (normalizeTag(text) === '') return;
  emit('submit-text', text);
  afterChoice();
}

function onOptionClick(suggestion: RelationSuggestion): void {
  choose(suggestion);
}

onBeforeUnmount(() => {
  clearPendingDebounce();
  activeController?.abort();
});
</script>

<template>
  <span class="suggestion-input">
    <input
      v-model="rawQuery"
      type="text"
      role="combobox"
      :aria-expanded="dropdownOpen"
      aria-autocomplete="list"
      :aria-controls="listId"
      :aria-activedescendant="highlightIndex >= 0 ? `${listId}-${highlightIndex}` : undefined"
      :aria-label="ariaLabel"
      :name="name"
      :size="inputSize"
      autocomplete="off"
      :placeholder="placeholder"
      @focus="onFocus"
      @blur="onBlur"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
      @keydown.enter="onEnter"
      @keydown.down.prevent="moveHighlight(1)"
      @keydown.up.prevent="moveHighlight(-1)"
      @keydown.esc.prevent="closed = true"
    >
    <ul
      v-if="dropdownOpen"
      :id="listId"
      class="suggestion-input__list"
      role="listbox"
    >
      <li
        v-for="(suggestion, index) in suggestions"
        :id="`${listId}-${index}`"
        :key="suggestion.id"
        role="option"
        :aria-selected="index === highlightIndex"
      >
        <button
          type="button"
          class="suggestion-input__option"
          :class="{ 'suggestion-input__option--highlighted': index === highlightIndex }"
          :data-suggestion-id="suggestion.id"
          @mousedown.prevent
          @click="onOptionClick(suggestion)"
        >
          <span>{{ suggestion.name }}</span>
          <span
            v-if="suggestion.matchedAlias"
            class="suggestion-input__alias"
          >{{ suggestion.matchedAlias }}</span>
        </button>
      </li>
      <li
        v-if="suggestions.length === 0 && !loading"
        class="suggestion-input__empty"
      >
        {{ t('suggestion.noMatches') }}
      </li>
    </ul>
  </span>
</template>

<style scoped>
.suggestion-input { position: relative; display: inline-flex; }
.suggestion-input input {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.55rem;
  background: var(--surface-muted);
  color: var(--text-primary);
  font: inherit;
  font-size: 0.85rem;
}
.suggestion-input input:focus { outline: none; border-color: var(--accent); }
.suggestion-input__list {
  position: absolute;
  z-index: 50;
  top: calc(100% + 0.25rem);
  left: 0;
  display: grid;
  gap: 0.1rem;
  min-width: 12rem;
  max-width: min(22rem, calc(100vw - 2.5rem));
  max-height: 14rem;
  margin: 0;
  overflow-y: auto;
  padding: 0.3rem;
  list-style: none;
  border: 1px solid var(--border-subtle);
  border-radius: 0.6rem;
  background: var(--surface);
  box-shadow: 0 0.75rem 2rem rgb(15 23 42 / 14%);
}
.suggestion-input__option {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0.55rem;
  border: 0;
  border-radius: 0.45rem;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
}
.suggestion-input__option:hover,
.suggestion-input__option:focus-visible { background: var(--surface-muted); outline: none; }
.suggestion-input__option--highlighted { background: var(--surface-muted); color: var(--accent); }
.suggestion-input__alias { color: var(--text-muted); font-size: 0.75rem; }
.suggestion-input__empty { padding: 0.35rem 0.55rem; color: var(--text-muted); font-size: 0.8rem; }
@media (max-width: 44rem) {
  /* Touch targets on phones match the 44px rows used elsewhere. */
  .suggestion-input__option { padding: 0.65rem 0.6rem; }
  .suggestion-input input { font-size: 1rem; }
}
</style>
