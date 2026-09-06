<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type {
  AuthorAliasGroup,
  ProducerMergeExecutionItem,
  ProducerMergePlanItem,
  ProducerMergePlanResponse,
  ProducerMergeResponse,
  TaxonomyAliasDto,
  TaxonomyVocabulary,
  UnassignedTagGroup,
  UpsertTaxonomyAliasRequest,
} from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import { useI18n } from './i18n.js';
import { parseTaxonomyDictionary } from './taxonomy-dictionary.js';
import { useArmableAction } from './armable.js';

const props = defineProps<{ api: GalleryApi }>();
const emit = defineEmits<{
  back: [];
  'authors-changed': [];
}>();
const { t } = useI18n();
const { armedKey, arm, disarm } = useArmableAction();

type Tab = 'dictionary' | 'merge' | 'unassigned' | 'templates' | 'authors';

interface TemplateSummaryDto {
  entryType: string;
  sections: Array<{ name: string; facets: string[] }>;
  mappings: Array<{ tag: string; section: string; facet: string }>;
  templatePath: string;
  tagLayoutPath: string;
  templateExists: boolean;
  tagLayoutExists: boolean;
}

const templates = ref<TemplateSummaryDto[]>([]);
const templatesLoaded = ref(false);
// The preview sketches the whole card: the gallery's shared rating slots and
// a generic Content block below the Section → Facet layout.
const templateRatingSlots = ref<Record<string, Array<{ id: number; name: string; sortOrder: number }>>>({});
const tab = ref<Tab>('dictionary');
const error = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Unassigned tags (per gallery). Lazy-loaded on first visit of the tab so
// opening Advanced editing does not pay for an extra request.
// ---------------------------------------------------------------------------
const unassignedGroups = ref<UnassignedTagGroup[]>([]);
const unassignedLoaded = ref(false);
const expandedUnassigned = ref<Set<string>>(new Set());
const targetForTag = ref<Record<number, number>>({});
const movingTagId = ref<number | null>(null);
const unassignedNotice = ref('');

async function fetchUnassigned(): Promise<void> {
  unassignedGroups.value = await props.api.listUnassignedTags();
  unassignedLoaded.value = true;
}

async function moveTag(group: UnassignedTagGroup, tagName: string, tagId: number, facetId: number | undefined): Promise<void> {
  const target = facetId ?? targetForTag.value[tagId];
  if (target === undefined) return;
  movingTagId.value = tagId;
  unassignedNotice.value = '';
  try {
    const result = await props.api.moveUnassignedTag({
      entryType: group.entryType,
      tagId,
      targetFacetId: target,
    });
    const targetName = group.facets.find((facet) => facet.facetId === target)?.facetName ?? '';
    unassignedNotice.value = t('unassigned.moved', {
      tag: tagName,
      facet: targetName,
      count: String(result.moved),
    });
    await fetchUnassigned(); // refresh the group so the row disappears
    delete targetForTag.value[tagId];
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    movingTagId.value = null;
  }
}

function toggleUnassignedGroup(entryType: string): void {
  const next = new Set(expandedUnassigned.value);
  if (next.has(entryType)) next.delete(entryType);
  else next.add(entryType);
  expandedUnassigned.value = next;
}

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
  if (!arm('run-merge')) return;
  disarm('run-merge');
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

// ---------------------------------------------------------------------------
// Author alias groups: one display name plus every tag-name spelling that
// must resolve to it. Saving writes producer-vocabulary dictionary rows and
// merges existing duplicate author rows into the display-name producer.
// ---------------------------------------------------------------------------
const authorAliasGroups = ref<AuthorAliasGroup[]>([]);
const authorAliasLoaded = ref(false);
const aliasDisplayName = ref('');
const aliasTagNames = ref<string[]>([]);
const aliasGroupBusy = ref(false);
const aliasGroupNotice = ref('');

async function loadAuthorAliasGroups(): Promise<void> {
  try {
    authorAliasGroups.value = await props.api.listAuthorAliasGroups();
    authorAliasLoaded.value = true;
    error.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('advanced.loadError');
  }
}

function addAliasTagRow(): void {
  aliasTagNames.value.push('');
}

function removeAliasTagRow(index: number): void {
  aliasTagNames.value.splice(index, 1);
}

async function saveAuthorAliasGroup(): Promise<void> {
  const displayName = aliasDisplayName.value.trim();
  const tagNames = aliasTagNames.value.map((name) => name.trim()).filter((name) => name !== '');
  if (!displayName || tagNames.length === 0) return;
  aliasGroupBusy.value = true;
  aliasGroupNotice.value = '';
  error.value = null;
  try {
    const result = await props.api.saveAuthorAliasGroup({ displayName, tagNames });
    const { deletedProducers, worksRelinked, renamed } = result.merge.totals;
    aliasGroupNotice.value = deletedProducers > 0 || renamed > 0
      ? t('authorAlias.mergeSummary', {
        display: result.group.canonicalName,
        merged: String(deletedProducers),
        works: String(worksRelinked),
        renamed: String(renamed),
      })
      : t('authorAlias.saved', { display: result.group.canonicalName });
    aliasDisplayName.value = '';
    aliasTagNames.value = [];
    await loadAuthorAliasGroups();
    emit('authors-changed');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('authorAlias.saveError');
  } finally {
    aliasGroupBusy.value = false;
  }
}

async function removeAuthorAlias(aliasId: number): Promise<void> {
  aliasGroupBusy.value = true;
  error.value = null;
  try {
    await props.api.deleteTaxonomyAlias(aliasId);
    await Promise.all([loadAuthorAliasGroups(), loadAliases()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('taxonomy.deleteError');
  } finally {
    aliasGroupBusy.value = false;
  }
}

onMounted(loadAliases);

watch(tab, (value) => {
  if (value === 'templates' && !templatesLoaded.value) {
    void props.api.listTemplates().then(async (summaries) => {
      templates.value = summaries;
      const slotLists = await Promise.all(summaries.map(async (summary) => {
        try {
          return await props.api.listRatingSlots(summary.entryType);
        } catch {
          return [];
        }
      }));
      templateRatingSlots.value = Object.fromEntries(summaries.map((summary, index) => ([
        summary.entryType,
        slotLists[index]!.map((slot) => ({ id: slot.id, name: slot.name, sortOrder: slot.sortOrder })),
      ])));
      templatesLoaded.value = true;
    }).catch((cause) => {
      error.value = cause instanceof Error ? cause.message : t('advanced.loadError');
    });
  }
  if (value === 'unassigned' && !unassignedLoaded.value) {
    fetchUnassigned().catch((reason) => {
      error.value = reason instanceof Error ? reason.message : String(reason);
    });
  }
  if (value === 'authors' && !authorAliasLoaded.value) {
    void loadAuthorAliasGroups();
  }
});
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
      <button
        data-testid="advanced-tab-unassigned"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'unassigned' }"
        @click="tab = 'unassigned'"
      >
        {{ t('advanced.unassignedTab') }}
      </button>
      <button
        data-testid="advanced-tab-templates"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'templates' }"
        @click="tab = 'templates'"
      >
        {{ t('advanced.templatesTab') }}
      </button>
      <button
        data-testid="advanced-tab-authors"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'authors' }"
        @click="tab = 'authors'"
      >
        {{ t('advanced.authorsTab') }}
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

    <section v-else-if="tab === 'merge'" data-testid="advanced-merge" class="advanced-card">
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
          :class="{ 'armable-armed': armedKey === 'run-merge' }"
          type="button"
          :disabled="mergeBusy"
          @click="runMerge"
        >
          {{ mergeBusy
            ? t('merge.executing')
            : armedKey === 'run-merge' ? t('merge.confirmRunShort', { count: String(plan?.plans.length ?? 0) }) : t('merge.execute') }}
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

    <section v-else-if="tab === 'unassigned'" data-testid="advanced-unassigned" class="advanced-card">
      <h3>{{ t('unassigned.title') }}</h3>
      <p class="muted">{{ t('unassigned.hint') }}</p>
      <p v-if="unassignedNotice" class="merge-integrity merge-integrity-pass" data-testid="unassigned-notice" role="status">
        {{ unassignedNotice }}
      </p>

      <div v-for="group in unassignedGroups" :key="group.entryType" class="alias-group">
        <button
          type="button"
          class="alias-group-header"
          :data-testid="`unassigned-group-${group.entryType}`"
          :aria-expanded="expandedUnassigned.has(group.entryType)"
          @click="toggleUnassignedGroup(group.entryType)"
        >
          <span class="alias-group-title">
            <span class="alias-caret" aria-hidden="true">{{ expandedUnassigned.has(group.entryType) ? '▾' : '▸' }}</span>
            {{ group.entryType }}
            <small>{{ group.tags.length }}</small>
          </span>
        </button>
        <ul v-if="expandedUnassigned.has(group.entryType)" data-testid="unassigned-tag-list" class="taxonomy-alias-list">
          <li
            v-for="tag in group.tags"
            :key="`${group.entryType}-${tag.tagId}`"
            :data-testid="`unassigned-tag-${tag.tagId}`"
            class="unassigned-row"
          >
            <span class="unassigned-tag-name">
              {{ tag.tagName }}
              <small>{{ t('unassigned.entries', { count: String(tag.entryCount) }) }}</small>
            </span>
            <label class="unassigned-target">
              {{ t('unassigned.moveTo') }}
              <select
                v-model.number="targetForTag[tag.tagId]"
                :data-testid="`unassigned-target-${tag.tagId}`"
              >
                <option :value="undefined" disabled>{{ t('unassigned.chooseFacet') }}</option>
                <option v-for="facet in group.facets" :key="facet.facetId" :value="facet.facetId">
                  {{ facet.facetName }}
                </option>
              </select>
            </label>
            <button
              type="button"
              class="secondary-button"
              :disabled="movingTagId === tag.tagId || targetForTag[tag.tagId] === undefined"
              :data-testid="`unassigned-move-${tag.tagId}`"
              @click="moveTag(group, tag.tagName, tag.tagId, undefined)"
            >
              {{ movingTagId === tag.tagId ? t('unassigned.moving') : t('unassigned.move') }}
            </button>
            <span v-if="tag.suggestion" class="unassigned-suggestion">
              {{ t('unassigned.majority', {
                facet: tag.suggestion.facetName,
                count: String(tag.suggestion.count),
              }) }}
              <button
                type="button"
                class="alias-action"
                :disabled="movingTagId === tag.tagId"
                :data-testid="`unassigned-follow-${tag.tagId}`"
                @click="moveTag(group, tag.tagName, tag.tagId, tag.suggestion!.facetId)"
              >
                {{ t('unassigned.follow') }}
              </button>
            </span>
          </li>
        </ul>
      </div>
      <p v-if="unassignedLoaded && unassignedGroups.length === 0" class="muted" data-testid="unassigned-empty">
        {{ t('unassigned.empty') }}
      </p>
    </section>

    <section v-else-if="tab === 'templates'" data-testid="advanced-templates" class="advanced-card">
      <h3>{{ t('advanced.templatesTab') }}</h3>
      <p class="muted">{{ t('templates.hint') }}</p>
      <p v-if="templatesLoaded && templates.length === 0" class="muted" data-testid="gallery-templates-empty">
        {{ t('templates.empty') }}
      </p>
      <div v-for="summary in templates" :key="summary.entryType" class="alias-group">
        <button
          type="button"
          class="alias-group-header"
          :data-testid="`gallery-template-${summary.entryType}`"
          :aria-expanded="expandedGroups.has(`template-${summary.entryType}`)"
          @click="toggleGroup(`template-${summary.entryType}`)"
        >
          <span class="alias-group-title">
            <span class="alias-caret" aria-hidden="true">{{ expandedGroups.has(`template-${summary.entryType}`) ? '▾' : '▸' }}</span>
            {{ summary.entryType }}
            <small>{{ t('templates.sectionsCount', { count: String(summary.sections.length) }) }}</small>
          </span>
        </button>
        <div v-if="expandedGroups.has(`template-${summary.entryType}`)" class="gallery-template-body">
          <!-- Rough preview of a full entry card under this template:
               Section → Facet layout, then Ratings, then Content. -->
          <div class="template-card-preview" :data-testid="`gallery-template-preview-${summary.entryType}`">
            <div v-for="section in summary.sections" :key="`${summary.entryType}-${section.name}`" class="template-preview-section">
              <span class="template-preview-section-name">{{ section.name }}</span>
              <div class="template-preview-facet-rows">
                <div
                  v-for="(facet, facetIndex) in section.facets"
                  :key="`${summary.entryType}-${section.name}-${facetIndex}`"
                  class="template-preview-facet-row"
                >
                  <span v-if="facet !== ''" class="template-preview-facet-label">{{ facet }}</span>
                  <span class="template-preview-facet-slot" />
                </div>
              </div>
            </div>
            <div class="template-preview-section" data-testid="gallery-template-preview-ratings">
              <span class="template-preview-section-name">{{ t('rating.title') }}</span>
              <div class="template-preview-facet-rows">
                <div
                  v-for="slot in templateRatingSlots[summary.entryType] ?? []"
                  :key="slot.id"
                  class="template-preview-facet-row"
                >
                  <span class="template-preview-facet-label">{{ slot.name }}</span>
                  <span class="template-preview-stars">★★★★★</span>
                </div>
                <span v-if="(templateRatingSlots[summary.entryType] ?? []).length === 0" class="template-preview-empty">
                  {{ t('templates.noRatingSlots') }}
                </span>
              </div>
            </div>
            <div class="template-preview-section">
              <span class="template-preview-section-name">{{ t('author.content') }}</span>
              <div class="template-preview-facet-rows">
                <div class="template-preview-facet-row">
                  <span class="template-preview-facet-label">source url</span>
                  <span class="template-preview-facet-slot" />
                </div>
                <div class="template-preview-facet-row">
                  <span class="template-preview-facet-slot template-preview-content-slot" />
                </div>
              </div>
            </div>
          </div>
          <p class="muted">{{ t('templates.pathHint') }}</p>
          <p class="muted" :data-testid="`gallery-template-files-${summary.entryType}`">
            <span>{{ summary.templateExists
              ? t('templates.templateFile', { path: summary.templatePath })
              : t('templates.fileMissing') }}</span>
            <span>{{ summary.tagLayoutExists
              ? t('templates.tagLayoutFile', { path: summary.tagLayoutPath })
              : t('templates.fileMissing') }}</span>
          </p>
        </div>
      </div>
    </section>

    <section v-else-if="tab === 'authors'" data-testid="advanced-authors" class="advanced-card">
      <h3>{{ t('advanced.authorsTab') }}</h3>
      <p class="muted">{{ t('authorAlias.hint') }}</p>
      <p v-if="aliasGroupNotice" class="merge-integrity merge-integrity-pass" data-testid="author-alias-notice" role="status">
        {{ aliasGroupNotice }}
      </p>

      <form data-testid="author-alias-form" class="alias-form" @submit.prevent="saveAuthorAliasGroup">
        <label>
          {{ t('authorAlias.displayName') }}
          <input
            v-model="aliasDisplayName"
            name="authorAliasDisplayName"
            :placeholder="t('authorAlias.displayNamePlaceholder')"
            required
            autocomplete="off"
          >
        </label>
        <div class="alias-tag-rows">
          <label v-for="(_name, index) in aliasTagNames" :key="`alias-tag-${index}`">
            {{ t('authorAlias.tagName') }}
            <span class="alias-tag-row">
              <input
                v-model="aliasTagNames[index]"
                :name="`authorAliasTag${index}`"
                :data-testid="`author-alias-tag-${index}`"
                :placeholder="t('authorAlias.tagNamePlaceholder')"
                autocomplete="off"
              >
              <button
                type="button"
                class="remove-tag-button"
                :aria-label="t('authorAlias.removeTag')"
                @click="removeAliasTagRow(index)"
              >×</button>
            </span>
          </label>
          <button
            type="button"
            class="alias-action"
            data-testid="author-alias-add-tag"
            @click="addAliasTagRow"
          >{{ t('authorAlias.addTag') }}</button>
        </div>
        <button class="primary-button" type="submit" :disabled="aliasGroupBusy || aliasTagNames.length === 0">
          {{ t('content.save') }}
        </button>
      </form>

      <h4>{{ t('authorAlias.groupsHeading') }}</h4>
      <p v-if="authorAliasLoaded && authorAliasGroups.length === 0" class="muted" data-testid="author-alias-empty">
        {{ t('authorAlias.empty') }}
      </p>
      <ul v-else data-testid="author-alias-group-list" class="merge-list">
        <li v-for="group in authorAliasGroups" :key="group.canonicalName" :data-testid="`author-alias-group-${group.canonicalName}`">
          <span class="unassigned-tag-name">
            {{ group.canonicalName }}
            <small v-if="group.producerName === null">{{ t('authorAlias.noProducer') }}</small>
          </span>
          <span class="author-alias-chips">
            <span v-for="alias in group.aliases" :key="alias.id" class="author-alias-chip">
              {{ alias.name }}
              <button
                type="button"
                class="remove-tag-button"
                :disabled="aliasGroupBusy"
                :aria-label="t('taxonomy.deleteAlias', { alias: alias.name })"
                :data-testid="`author-alias-remove-${alias.id}`"
                @click="removeAuthorAlias(alias.id)"
              >×</button>
            </span>
          </span>
        </li>
      </ul>
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
.armable-armed { border-color: #a12626; color: #a12626; background: #fff0f0; }
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
.alias-tag-rows { display: grid; gap: 0.55rem; }
.alias-tag-row { display: flex; align-items: center; gap: 0.4rem; }
.alias-tag-row input { flex: 1; }
.author-alias-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.author-alias-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--tag-border);
  border-radius: 999px;
  color: var(--tag-text);
  background: var(--tag-background);
  font-size: 0.78rem;
}
.gallery-template-body { display: grid; gap: 0.4rem; padding: 0.35rem 0.55rem 0.55rem; }
.gallery-template-body .muted { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0; }
/* Rough sketch of an entry card under the saved template: section dividers
   with a label column and an empty tag slot per facet row. */
.template-card-preview {
  display: grid;
  gap: 0;
  max-width: 22rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.6rem;
  background: var(--surface-muted);
  padding: 0.6rem 0.7rem;
}
.template-preview-section { display: grid; gap: 0.35rem; padding: 0.5rem 0; border-top: 1px dashed var(--border-subtle); }
.template-preview-section:first-child { border-top: 0; padding-top: 0.15rem; }
.template-preview-section-name { color: var(--text-primary); font-weight: 800; font-size: 0.82rem; }
.template-preview-facet-rows { display: grid; gap: 0.35rem; }
.template-preview-facet-row { display: grid; grid-template-columns: minmax(3.5rem, 7rem) minmax(0, 1fr); align-items: center; gap: 0.7rem; }
.template-preview-facet-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 0.78rem; }
.template-preview-facet-slot { display: block; height: 1.15rem; border: 1px dashed var(--border-subtle); border-radius: 0.4rem; background: var(--surface); opacity: 0.75; }
.template-preview-content-slot { grid-column: 1 / -1; }
.template-preview-stars { color: var(--text-muted); opacity: 0.6; font-size: 0.85rem; letter-spacing: 0.08em; }
.template-preview-empty { color: var(--text-muted); font-size: 0.75rem; opacity: 0.7; }
.merge-result h4 { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.8rem; color: var(--text-muted); }
.merge-integrity { margin: 0; font-size: 0.8rem; }
.merge-integrity-pass { color: var(--accent); }
.merge-integrity-fail { color: #a12626; }
.unassigned-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
.unassigned-tag-name { display: inline-flex; align-items: baseline; gap: 0.4rem; font-weight: 600; font-size: 0.88rem; }
.unassigned-tag-name small { color: var(--text-muted); font-weight: 400; }
.unassigned-target { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; color: var(--text-muted); }
.unassigned-suggestion { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; color: var(--text-muted); }
.error-message { margin: 0; padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }
@media (min-width: 34rem) {
  .alias-form { grid-template-columns: minmax(7rem, 0.4fr) minmax(9rem, 0.5fr) minmax(0, 1fr) auto minmax(0, 1fr) auto; align-items: end; }
}
</style>
