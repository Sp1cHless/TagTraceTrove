<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
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
const inputElement = ref<HTMLInputElement | null>(null);
/**
 * A phone keyboard shrinks the visual viewport, so a list opening downward is
 * painted under the keyboard (measured: 23px of room below the field, the list
 * 87px tall). The list flips above the field and is bounded to the room on
 * whichever side it lands.
 */
const dropUp = ref(false);
const LIST_PREFERRED_HEIGHT = 224;
const LIST_MIN_HEIGHT = 88;
const listMaxHeight = ref(LIST_PREFERRED_HEIGHT);

function measurePlacement(): void {
  const input = inputElement.value;
  if (input === null) return;
  const rect = input.getBoundingClientRect();
  const viewport = globalThis.visualViewport;
  const viewportTop = viewport === undefined || viewport === null ? 0 : viewport.offsetTop;
  const viewportBottom = viewport === undefined || viewport === null
    ? globalThis.innerHeight
    : Math.min(globalThis.innerHeight, viewport.height + viewport.offsetTop);
  const spaceBelow = viewportBottom - rect.bottom - 8;
  const spaceAbove = rect.top - viewportTop - 8;
  // Flip only when the field cannot show a usable list below and the other side
  // is roomier — a desktop field keeps opening downward.
  const flip = spaceBelow < LIST_MIN_HEIGHT && spaceAbove > spaceBelow;
  dropUp.value = flip;
  listMaxHeight.value = Math.max(
    LIST_MIN_HEIGHT,
    Math.min(LIST_PREFERRED_HEIGHT, flip ? spaceAbove : spaceBelow),
  );
}
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
let lastScheduledQuery: string | null = null;

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
  if (activeQuery.value === '') {
    clearPendingDebounce();
    resetResults();
    return;
  }
  // One queued search per query: a second caller for the same text (focus
  // arriving right after typing did) must not cancel the pending one and
  // schedule nothing in its place. A query whose search already ran is
  // scheduled again on purpose — that is the retry path.
  if (debounceHandle !== null && activeQuery.value === lastScheduledQuery) return;
  clearPendingDebounce();
  lastScheduledQuery = activeQuery.value;
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
  measurePlacement();
  // Searching during IME composition too: a phone's keyboard can hold a
  // composition open for plain letters, and gating here meant the candidates
  // only appeared after leaving and re-entering the field. Mid-composition
  // queries are debounced like any other; they never submit on their own.
  scheduleSearch();
});

// The keyboard opens *after* focus and shrinks the viewport, so a placement
// measured at focus time is stale by the time the list appears. Scrolling
// moves the field inside that viewport without changing the viewport itself,
// which is why the page's own scroll is watched too — the shell's scroll into
// view is not a viewport resize (measured: the field moved from y377 to y30
// with no resize event and the list stayed flipped).
function onViewportChange(): void {
  if (!dropdownOpen.value) return;
  measurePlacement();
}

onMounted(() => {
  globalThis.addEventListener('resize', onViewportChange);
  globalThis.visualViewport?.addEventListener('resize', onViewportChange);
  globalThis.visualViewport?.addEventListener('scroll', onViewportChange);
  document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
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

/**
 * The field's text is read from the element itself, not through `v-model`:
 * Vue's own model listener drops `input` events while an IME composition is
 * open, and a phone keyboard holds that composition open for as long as plain
 * letters are being typed. The query then stayed at its previous value, no
 * search was ever dispatched, and the candidates only appeared once the
 * composition committed (the user's "nothing shows until I tap away").
 * Measured on the device: the element carried `composing === true`, the query
 * did not move, and clearing the flag let the very same event through.
 */
function onInputEvent(event: Event): void {
  rawQuery.value = (event.target as HTMLInputElement).value;
}

function onCompositionEnd(): void {
  composing.value = false;
  // The composition watcher already dispatched a search for this text; a query
  // that has not been dispatched yet gets one.
  if (lastScheduledQuery !== activeQuery.value) scheduleSearch();
}

function onFocus(): void {
  focused.value = true;
  closed.value = false;
  measurePlacement();
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
  if (!composing.value && props.mode === 'id-only' && rawQuery.value.trim() !== '') {
    // id-only editors (Author link, Tag merge) need a real record, but the user
    // should not have to pick from the dropdown: typing the full name and then
    // clicking away resolves it whenever the text matches a candidate exactly.
    const exact = exactMatch();
    if (exact !== null) {
      choose(exact);
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

/** Exact match by normalized canonical name or alias — only a full-string hit
 * counts, so Enter can never link a guessed neighbour. */
function exactMatch(): RelationSuggestion | null {
  const query = activeQuery.value;
  if (query === '') return null;
  return suggestions.value.find((suggestion) => (
    normalizeTag(suggestion.name) === query
    || (suggestion.matchedAlias !== undefined && normalizeTag(suggestion.matchedAlias) === query)
  )) ?? null;
}

function onEnter(event: KeyboardEvent): void {
  event.preventDefault();
  // The event's own flag, not the component's: a phone keyboard can hold a
  // composition open across a whole typing session without ever announcing its
  // end, and the stale flag then swallowed every Enter — measured on the device
  // in the offline tag editor, where a typed tag was created only when the
  // field lost focus ("it shows up after I press Done"). While the composition
  // really is in progress the key belongs to the IME.
  if (event.isComposing) return;
  composing.value = false;
  if (dropdownOpen.value) {
    const highlighted = suggestions.value[highlightIndex.value];
    if (highlighted) {
      choose(highlighted);
      return;
    }
    // id-only editors (Author link): typing the full existing name and
    // pressing Enter links that exact author instead of doing nothing.
    if (props.mode === 'id-only') {
      const exact = exactMatch();
      if (exact !== null) {
        choose(exact);
        return;
      }
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
  globalThis.removeEventListener('resize', onViewportChange);
  globalThis.visualViewport?.removeEventListener('resize', onViewportChange);
  globalThis.visualViewport?.removeEventListener('scroll', onViewportChange);
  document.removeEventListener('scroll', onViewportChange, { capture: true });
});
</script>

<template>
  <span class="suggestion-input">
    <input
      ref="inputElement"
      :value="rawQuery"
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
      @input="onInputEvent"
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
      :class="{ 'suggestion-input__list--up': dropUp }"
      :style="{ maxHeight: `${listMaxHeight}px` }"
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
          <span class="t3-library-text">{{ suggestion.name }}</span>
          <span
            v-if="suggestion.matchedAlias"
            class="suggestion-input__alias t3-library-text"
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
/* Building the flipped rule on both class names, not just the state class: with
   equal specificity the base rule's `top` won by source order and the flipped
   list collapsed to its 12px padding (measured on the device under the
   keyboard). */
.suggestion-input .suggestion-input__list--up { top: auto; bottom: calc(100% + 0.25rem); }
.suggestion-input__list {
  position: absolute;
  z-index: 50;
  top: calc(100% + 0.25rem);
  left: 0;
  display: grid;
  gap: 0.1rem;
  min-width: 12rem;
  max-width: min(22rem, calc(100vw - 2.5rem));
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
