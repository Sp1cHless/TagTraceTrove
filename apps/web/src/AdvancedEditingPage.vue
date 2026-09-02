<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type {
  ProducerMergeExecutionItem,
  ProducerMergePlanItem,
  ProducerMergePlanResponse,
  ProducerMergeResponse,
  TaxonomyAliasDto,
  TaxonomyVocabulary,
  UpsertTaxonomyAliasRequest,
} from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import { useI18n } from './i18n.js';
import { parseTaxonomyDictionary } from './taxonomy-dictionary.js';

const props = defineProps<{ api: GalleryApi }>();
const emit = defineEmits<{
  back: [];
  'authors-changed': [];
}>();
const { t } = useI18n();

type Tab = 'dictionary' | 'merge';
const tab = ref<Tab>('dictionary');
const error = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Dictionary (tag aliases), partitioned like the tag taxonomy
// ---------------------------------------------------------------------------
const aliases = ref<TaxonomyAliasDto[]>([]);
const vocabulary = ref<TaxonomyVocabulary>('entry');
const partition = ref('');
const aliasName = ref('');
const canonicalName = ref('');
const busy = ref(false);
const importSummary = ref('');

const entryPartitions = ['series', 'characters', 'types', 'tags'];
const producerPartitions = ['authors'];
const partitionOptions = computed(() => (
  vocabulary.value === 'producer' ? producerPartitions : entryPartitions
));

watch(vocabulary, () => {
  partition.value = '';
});

const partitionOrder = ['series', 'characters', 'types', 'tags', 'authors', ''];

// Alias list display: groups start collapsed (a long dictionary otherwise
// floods the page); toggling a group header expands it. `onlyUnmatched`
// narrows every group to placeholder rows (canonicalName === '') so the user
// can work through dictionary blanks without scrolling past filled entries.
const expandedGroups = ref<Set<string>>(new Set());
const onlyUnmatched = ref(false);

function toggleGroup(key: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedGroups.value = next;
}

const visibleGroups = computed<AliasGroup[]>(() => {
  const groups = onlyUnmatched.value
    ? aliasGroups.value
      .map((group) => ({ ...group, items: group.items.filter((alias) => alias.canonicalName === '') }))
      .filter((group) => group.items.length > 0)
    : aliasGroups.value;
  return groups;
});

// Showing only unmatched rows is meant for working the blanks: expand every
// group automatically so nothing stays hidden behind a collapsed header.
watch(onlyUnmatched, (active) => {
  if (!active) return;
  const next = new Set(expandedGroups.value);
  for (const group of aliasGroups.value) next.add(group.key);
  expandedGroups.value = next;
});

function partitionLabel(value: string): string {
  switch (value) {
    case 'series': return t('partition.series');
    case 'characters': return t('partition.characters');
    case 'types': return t('partition.types');
    case 'tags': return t('partition.tags');
    case 'authors': return t('partition.authors');
    default: return t('taxonomy.unpartitioned');
  }
}

interface AliasGroup {
  key: string;
  vocabulary: TaxonomyVocabulary;
  partition: string;
  items: TaxonomyAliasDto[];
}

const aliasGroups = computed<AliasGroup[]>(() => {
  const groups = new Map<string, AliasGroup>();
  for (const alias of aliases.value) {
    const key = `${alias.vocabulary}\u0000${alias.partition}`;
    const group = groups.get(key) ?? {
      key,
      vocabulary: alias.vocabulary,
      partition: alias.partition,
      items: [],
    };
    group.items.push(alias);
    groups.set(key, group);
  }
  const vocabularyOrder = (value: TaxonomyVocabulary): number => (
    value === 'entry' ? 0 : 1
  );
  return [...groups.values()].sort((left, right) => {
    const vocabularyDelta = vocabularyOrder(left.vocabulary) - vocabularyOrder(right.vocabulary);
    if (vocabularyDelta !== 0) return vocabularyDelta;
    return partitionOrder.indexOf(left.partition) - partitionOrder.indexOf(right.partition);
  });
});

async function loadAliases(): Promise<void> {
  try {
    aliases.value = await props.api.listTaxonomyAliases();
    error.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('advanced.loadError');
  }
}

async function saveAlias(): Promise<void> {
  const request: UpsertTaxonomyAliasRequest = {
    vocabulary: vocabulary.value,
    partition: partition.value,
    alias: aliasName.value.trim(),
    canonicalName: canonicalName.value.trim(),
  };
  if (!request.alias || !request.canonicalName) return;
  busy.value = true;
  error.value = null;
  try {
    await props.api.upsertTaxonomyAlias(request);
    aliasName.value = '';
    canonicalName.value = '';
    await loadAliases();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('taxonomy.saveError');
  } finally {
    busy.value = false;
  }
}

async function removeAlias(aliasId: number): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await props.api.deleteTaxonomyAlias(aliasId);
    await loadAliases();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('taxonomy.deleteError');
  } finally {
    busy.value = false;
  }
}

/** Loads a placeholder row (imported name, no canonical yet) into the form. */
function startFill(alias: TaxonomyAliasDto): void {
  vocabulary.value = alias.vocabulary;
  partition.value = alias.partition;
  aliasName.value = alias.alias;
  canonicalName.value = '';
}

async function importDictionary(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  busy.value = true;
  importSummary.value = '';
  error.value = null;
  try {
    const rows = parseTaxonomyDictionary(JSON.parse(await file.text()) as unknown);
    if (rows.length === 0) throw new Error(t('taxonomy.noMappings'));
    await props.api.importTaxonomyAliases({ aliases: rows });
    const pending = rows.filter((row) => row.canonicalName === '').length;
    importSummary.value = t('taxonomy.imported', {
      count: rows.length,
      pending,
    });
    await loadAliases();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('taxonomy.importError');
  } finally {
    busy.value = false;
    input.value = '';
  }
}

// ---------------------------------------------------------------------------
// One-click author merge with a before/after report
// ---------------------------------------------------------------------------
const mergeBusy = ref(false);
const plan = ref<ProducerMergePlanResponse | null>(null);
const result = ref<ProducerMergeResponse | null>(null);

async function loadPlan(): Promise<void> {
  mergeBusy.value = true;
  error.value = null;
  result.value = null;
  try {
    plan.value = await props.api.planProducerMerge();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('merge.planError');
  } finally {
    mergeBusy.value = false;
  }
}

function planLine(item: ProducerMergePlanItem): string {
  if (item.others.length === 0 && item.canonicalName !== null) {
    return t('merge.planRenamed', {
      id: item.keeper.id,
      name: item.keeper.name,
      canonical: item.canonicalName,
    });
  }
  return t('merge.planItem', {
    count: item.others.length + 1,
    display: item.canonicalName ?? item.keeper.name,
  });
}

async function runMerge(): Promise<void> {
  if (!plan.value || plan.value.plans.length === 0) return;
  if (!window.confirm(t('merge.confirm', { count: plan.value.plans.length }))) return;
  mergeBusy.value = true;
  error.value = null;
  try {
    result.value = await props.api.executeProducerMerge();
    plan.value = null;
    emit('authors-changed');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('merge.executeError');
  } finally {
    mergeBusy.value = false;
  }
}

function resultLine(item: ProducerMergeExecutionItem): string {
  const count = item.absorbedProducers + 1;
  if (item.renamedTo !== null && item.renamedFrom !== null && count === 1) {
    return t('merge.singleRenamed', { from: item.renamedFrom, to: item.renamedTo });
  }
  return item.canonicalName === null
    ? t('merge.mergedIdentical', {
      count,
      name: item.keeperName,
      id: item.keeperId,
    })
    : t('merge.mergedDictionary', {
      count,
      name: item.keeperName,
      id: item.keeperId,
    });
}

function resultDetail(item: ProducerMergeExecutionItem): string[] {
  const parts: string[] = [];
  if (item.worksRelinked > 0) parts.push(t('merge.transferredWorks', { n: item.worksRelinked }));
  if (item.tagsRelinked > 0) parts.push(t('merge.transferredTags', { n: item.tagsRelinked }));
  const directories = item.directoriesMoved + item.directoriesMerged;
  if (directories > 0) parts.push(t('merge.transferredDirectories', { n: directories }));
  return parts;
}

onMounted(loadAliases);
</script>

<template>
  <section data-testid="advanced-page" class="advanced-page">
    <header class="advanced-toolbar">
      <button data-testid="advanced-back" class="back-button" type="button" @click="emit('back')">
        {{ t('advanced.back') }}
      </button>
      <h2>{{ t('advanced.title') }}</h2>
    </header>

    <nav class="advanced-tabs" aria-label="advanced">
      <button
        data-testid="advanced-tab-dictionary"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'dictionary' }"
        @click="tab = 'dictionary'"
      >
        {{ t('advanced.dictionaryTab') }}
      </button>
      <button
        data-testid="advanced-tab-merge"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'merge' }"
        @click="tab = 'merge'"
      >
        {{ t('advanced.mergeTab') }}
      </button>
    </nav>

    <p v-if="error" class="error-message" role="alert">{{ error }}</p>

    <section v-if="tab === 'dictionary'" data-testid="advanced-dictionary" class="advanced-card">
      <h3>{{ t('taxonomy.title') }}</h3>
      <p class="muted">{{ t('taxonomy.hint') }}</p>

      <label>
        {{ t('taxonomy.importDictionary') }}
        <input
          data-testid="taxonomy-dictionary-input"
          type="file"
          accept="application/json,.json"
          :disabled="busy"
          @change="importDictionary"
        >
      </label>
      <p v-if="importSummary" class="muted" data-testid="taxonomy-import-summary">
        {{ importSummary }}
      </p>

      <form data-testid="taxonomy-alias-form" class="alias-form" @submit.prevent="saveAlias">
        <label>
          {{ t('taxonomy.vocabulary') }}
          <select v-model="vocabulary" data-testid="taxonomy-vocabulary-select" name="taxonomyVocabulary">
            <option value="entry">{{ t('taxonomy.entry') }}</option>
            <option value="producer">{{ t('taxonomy.producer') }}</option>
          </select>
        </label>
        <label>
          {{ t('taxonomy.partition') }}
          <select v-model="partition" data-testid="taxonomy-partition-select" name="taxonomyPartition">
            <option value="">{{ t('taxonomy.unpartitioned') }}</option>
            <option v-for="candidate in partitionOptions" :key="candidate" :value="candidate">
              {{ partitionLabel(candidate) }}
            </option>
          </select>
        </label>
        <label>
          {{ t('taxonomy.alias') }}
          <input
            v-model="aliasName"
            name="taxonomyAlias"
            :placeholder="t('taxonomy.alias')"
            required
            autocomplete="off"
          >
        </label>
        <span class="alias-arrow">→</span>
        <label>
          {{ t('taxonomy.canonical') }}
          <input
            v-model="canonicalName"
            name="taxonomyCanonicalName"
            :placeholder="t('taxonomy.canonical')"
            required
            autocomplete="off"
          >
        </label>
        <button class="primary-button" type="submit" :disabled="busy">{{ t('content.save') }}</button>
      </form>

      <label class="unmatched-filter">
        <input
          v-model="onlyUnmatched"
          type="checkbox"
          data-testid="taxonomy-unmatched-only"
        >
        {{ t('taxonomy.onlyUnmatched') }}
      </label>

      <div v-for="group in visibleGroups" :key="group.key" class="alias-group">
        <button
          type="button"
          class="alias-group-header"
          :data-testid="`taxonomy-group-${group.partition || 'unpartitioned'}`"
          :aria-expanded="expandedGroups.has(group.key)"
          @click="toggleGroup(group.key)"
        >
          <span class="alias-group-title">
            <span class="alias-caret" aria-hidden="true">{{ expandedGroups.has(group.key) ? '▾' : '▸' }}</span>
            {{ partitionLabel(group.partition) }}
            <small>{{ t(`taxonomy.${group.vocabulary}`) }} · {{ group.items.length }}</small>
          </span>
        </button>
        <ul v-if="expandedGroups.has(group.key)" data-testid="taxonomy-alias-list" class="taxonomy-alias-list">
          <li v-for="alias in group.items" :key="alias.id">
            <span>
              {{ alias.alias }} →
              <em v-if="alias.canonicalName === ''" class="alias-placeholder">
                {{ t('taxonomy.placeholder') }}
              </em>
              <template v-else>{{ alias.canonicalName }}</template>
            </span>
            <button
              v-if="alias.canonicalName === ''"
              type="button"
              class="alias-action"
              :disabled="busy"
              :data-testid="`taxonomy-fill-${alias.id}`"
              @click="startFill(alias)"
            >
              {{ t('taxonomy.fillPlaceholder') }}
            </button>
            <button
              type="button"
              class="remove-tag-button"
              :disabled="busy"
              :aria-label="t('taxonomy.deleteAlias', { alias: alias.alias })"
              @click="removeAlias(alias.id)"
            >×</button>
          </li>
        </ul>
      </div>
      <p v-if="onlyUnmatched && visibleGroups.length === 0" class="muted" data-testid="taxonomy-no-unmatched">
        {{ t('taxonomy.noUnmatched') }}
      </p>
    </section>

    <section v-else data-testid="advanced-merge" class="advanced-card">
      <h3>{{ t('advanced.mergeTab') }}</h3>
      <p class="muted">{{ t('merge.hint') }}</p>

      <div class="merge-actions">
        <button
          data-testid="merge-plan-button"
          class="secondary-button"
          type="button"
          :disabled="mergeBusy"
          @click="loadPlan"
        >
          {{ mergeBusy ? t('merge.planning') : t('merge.plan') }}
        </button>
        <button
          v-if="plan && plan.plans.length > 0"
          data-testid="merge-run-button"
          class="secondary-button danger-button"
          type="button"
          :disabled="mergeBusy"
          @click="runMerge"
        >
          {{ mergeBusy ? t('merge.executing') : t('merge.execute') }}
        </button>
      </div>

      <p v-if="plan && plan.plans.length === 0" class="muted">{{ t('merge.noPlans') }}</p>
      <ul v-if="plan && plan.plans.length > 0" data-testid="merge-plan-list" class="merge-list">
        <li
          v-for="(item, index) in plan.plans"
          :key="`${item.keeper.id}-${item.keeper.name}`"
          :data-testid="`merge-plan-item-${index}`"
        >
          {{ planLine(item) }}
        </li>
      </ul>

      <section v-if="result" data-testid="merge-result" class="merge-result">
        <h4>{{ t('merge.resultHeading') }}</h4>
        <ul class="merge-list">
          <li
            v-for="(item, index) in result.plans"
            :key="`${item.keeperId}-${item.keeperName}`"
            :data-testid="`merge-result-item-${index}`"
          >
            {{ resultLine(item) }}
            <small v-if="resultDetail(item).length > 0">{{ resultDetail(item).join(' · ') }}</small>
          </li>
        </ul>
        <p data-testid="merge-totals">{{ t('merge.totals', {
          deleted: result.totals.deletedProducers,
          works: result.totals.worksRelinked,
          renamed: result.totals.renamed,
        }) }}</p>
        <p v-if="result.backupPath" class="muted" data-testid="merge-backup">
          {{ t('merge.backupPath', { path: result.backupPath }) }}
        </p>
        <p
          class="merge-integrity"
          :class="result.foreignKeyCheckPass && result.doctorPass ? 'merge-integrity-pass' : 'merge-integrity-fail'"
          data-testid="merge-integrity"
        >
          {{ result.foreignKeyCheckPass && result.doctorPass
            ? t('merge.integrityPass')
            : t('merge.integrityFail', { issues: result.doctorIssues.join('; ') || 'foreign_key_check' }) }}
        </p>
      </section>
    </section>
  </section>
</template>

<style scoped>
.advanced-page { display: grid; gap: 1.25rem; }
.advanced-toolbar { display: flex; align-items: center; gap: 1rem; }
.advanced-toolbar h2 { margin: 0; }
.advanced-tabs { display: flex; gap: 0.5rem; }
.advanced-tabs .secondary-button.active { border-color: var(--accent); color: var(--accent); }
.advanced-card {
  display: grid;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid var(--border-subtle);
  border-radius: 20px;
  background: var(--surface);
}
.advanced-card h3 { margin: 0; }
.advanced-card h4 { margin: 0; font-size: 0.9rem; }
.advanced-card .muted { margin: 0; font-size: 0.78rem; line-height: 1.5; }
.alias-form { display: grid; gap: 0.7rem; padding: 1rem; border-radius: 14px; background: var(--surface-muted); }
.alias-form label { display: grid; gap: 0.35rem; font-size: 0.78rem; color: var(--text-muted); font-weight: 700; }
.alias-form input, .alias-form select {
  min-width: 0;
  padding: 0.52rem 0.6rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.55rem;
  color: var(--text-primary);
  background: var(--surface);
  font: inherit;
  font-weight: 400;
}
.alias-arrow { text-align: center; color: var(--text-muted); }
.primary-button { padding: 0.5rem 0.8rem; border: 1px solid var(--accent); border-radius: 0.55rem; color: white; background: var(--accent); font: inherit; cursor: pointer; }
.primary-button:disabled { opacity: 0.55; cursor: default; }
.secondary-button { padding: 0.5rem 0.8rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface); font: inherit; cursor: pointer; }
.secondary-button:disabled { opacity: 0.55; cursor: default; }
.back-button { padding: 0; border: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }
.danger-button { border-color: #a12626; color: #a12626; }
.unmatched-filter {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.8rem;
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
}
.alias-group { display: grid; gap: 0.45rem; }
.alias-group-header {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0.4rem 0.35rem;
  border: 0;
  border-radius: 0.5rem;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.alias-group-header:hover, .alias-group-header:focus-visible { background: var(--surface-muted); }
.alias-group-title { display: flex; align-items: baseline; gap: 0.5rem; font-weight: 700; font-size: 0.9rem; }
.alias-caret { font-size: 0.72rem; color: var(--text-muted); width: 1em; }
.alias-group-title small { color: var(--text-muted); font-weight: 400; }
.taxonomy-alias-list { display: grid; gap: 0.35rem; margin: 0; padding: 0; list-style: none; max-height: 16rem; overflow-y: auto; }
.taxonomy-alias-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.55rem;
  border-radius: 0.5rem;
  background: var(--surface-muted);
}
.alias-placeholder { color: var(--text-muted); opacity: 0.8; }
.alias-action {
  padding: 0.25rem 0.55rem;
  border: 1px dashed var(--border-subtle);
  border-radius: 0.5rem;
  color: var(--accent);
  background: transparent;
  font: inherit;
  font-size: 0.72rem;
  cursor: pointer;
}
.remove-tag-button { padding: 0; border: 0; color: var(--text-muted); background: transparent; font: inherit; line-height: 1; cursor: pointer; opacity: 0.55; }
.remove-tag-button:hover, .remove-tag-button:focus-visible { opacity: 1; }
.merge-actions { display: flex; gap: 0.5rem; }
.merge-list { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.merge-list li {
  display: grid;
  gap: 0.2rem;
  padding: 0.55rem 0.7rem;
  border-radius: 0.6rem;
  background: var(--surface-muted);
  font-size: 0.86rem;
}
.merge-list small { color: var(--text-muted); }
.merge-result { display: grid; gap: 0.6rem; }
.merge-result h4 { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.8rem; color: var(--text-muted); }
.merge-integrity { margin: 0; font-size: 0.8rem; }
.merge-integrity-pass { color: var(--accent); }
.merge-integrity-fail { color: #a12626; }
.error-message { margin: 0; padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }
@media (min-width: 34rem) {
  .alias-form { grid-template-columns: minmax(7rem, 0.4fr) minmax(9rem, 0.5fr) minmax(0, 1fr) auto minmax(0, 1fr) auto; align-items: end; }
}
</style>
