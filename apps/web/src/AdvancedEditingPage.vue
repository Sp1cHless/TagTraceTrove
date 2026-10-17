<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  DEFAULT_CONTENT_KINDS,
  type AuthorAliasGroup,
  type ProducerMergeExecutionItem,
  type ProducerMergePlanItem,
  type ProducerMergePlanResponse,
  type ProducerMergeResponse,
  type TaxonomyAliasDto,
  type TitleShorteningChange,
  type TitleShorteningPlanResponse,
  type TitleShorteningSide,
  type ApplyTitleShorteningResponse,
  type RelationSuggestion,
  type TaxonomyVocabulary,
  type UpsertTaxonomyAliasRequest,
} from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import { showNsfw } from './stores/preferences.js';
import { useI18n } from './i18n.js';
import { parseTaxonomyDictionary } from './taxonomy-dictionary.js';
import SuggestionInput from './components/SuggestionInput.vue';
import SourceMaintenancePanel from './SourceMaintenancePanel.vue';
import { useArmableAction } from './armable.js';
import OfflineLibrarySettings from './components/OfflineLibrarySettings.vue';
import type { SnapshotStore } from './offline/snapshot-store.js';
import {
  createBackup,
  downloadBackup,
  fetchBackups,
  fetchSystemDiagnostics,
  fetchSystemSettings,
  removeBackup,
  saveSystemSettings,
  stageRestore,
  type BackupEntry,
  type SystemDiagnostics,
  type SystemSettings,
  type StagedRestore,
} from './system-api.js';
import { clientErrors, clearClientErrors } from './client-errors.js';
import { browserCompatibilityReport } from './browser-compat.js';
import { copyText } from './clipboard.js';
import { readNativePairingDiagnostics } from './pairing-diagnostics.js';

const props = defineProps<{ api: GalleryApi; store: SnapshotStore; online: boolean; offlineCopyRevision?: string | null; initialTab?: Tab }>();
const emit = defineEmits<{
  back: [];
  'authors-changed': [];
  'works-changed': [];
  /** The offline copy changed (downloaded, cleared or restored): the pages
   *  showing it have to be re-read. */
  updated: [];
}>();
const { t } = useI18n();
const { armedKey, arm, disarm } = useArmableAction();

type Tab = 'tags' | 'authors' | 'templates' | 'sources' | 'offline' | 'system';

/** The common template, as the API returns it: just its name and the structure it carries. */
interface CommonTemplateDto {
  name: string;
  sections: Array<{ name: string; facets: string[] }>;
  ratingSlots: string[];
}

interface TemplateSummaryDto {
  entryType: string;
  sections: Array<{ name: string; facets: string[] }>;
  mappings: Array<{ tag: string; section: string; facet: string }>;
  /** The Content kinds a work of this Gallery carries, built-ins first. */
  contentKinds: string[];
  templatePath: string;
  tagLayoutPath: string;
  templateExists: boolean;
  tagLayoutExists: boolean;
}

const templates = ref<TemplateSummaryDto[]>([]);
/**
 * The common template: repository content, not a Gallery's own.
 *
 * It is listed here — beside the Galleries' templates, because this is where a person looks for
 * "what structure does a work get" — and it is deliberately *not* one of them: nothing here edits
 * it, and applying it copies its Sections and Facets into a Gallery as that Gallery's own.
 */
const commonTemplate = ref<CommonTemplateDto | null>(null);
const templatesLoaded = ref(false);
// The preview sketches the whole card: the gallery's shared rating slots and
// a generic Content block below the Section → Facet layout.
const templateRatingSlots = ref<Record<string, Array<{ id: number; name: string; sortOrder: number }>>>({});
const tab = ref<Tab>(props.initialTab ?? 'tags');
const error = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Dictionary (tag aliases), partitioned like the tag taxonomy
// ---------------------------------------------------------------------------
const aliases = ref<TaxonomyAliasDto[]>([]);
const aliasName = ref('');
const canonicalName = ref('');
const busy = ref(false);
const importSummary = ref('');

// Author identity aliases live in the authors tab now; this dictionary works
// on the Entry vocabulary only (partitions: series / characters / types / tags).

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

/**
 * The dictionary's two lists: the names that carry a mapping, and the ones still waiting for one.
 *
 * The headings used to be the tool's *sections* — series, characters, tags, authors — which is how the
 * three hand-written site adapters happened to split what they read from a page. A generic adapter
 * reads one field, so every tag arrives together and there is no section to file it under; carrying
 * them through made this page promise a split the database never had (a Tag's classification is its
 * Facet, which the import learns from where the tag already lives) and left headings that could never
 * receive anything again. What is left is the only distinction the dictionary can really make.
 */
function aliasGroupLabel(mapped: boolean): string {
  return mapped ? t('taxonomy.groupMapped') : t('taxonomy.groupPending');
}

interface AliasGroup {
  key: string;
  mapped: boolean;
  items: TaxonomyAliasDto[];
}

const aliasGroups = computed<AliasGroup[]>(() => {
  const groups = new Map<string, AliasGroup>();
  for (const alias of aliases.value) {
    // The author dictionary has its own page (`作者别名`), which is the better view of the same rows:
    // one display name with every spelling that resolves to it. This page is about Tags.
    if (alias.vocabulary !== 'entry') continue;
    const mapped = alias.canonicalName !== '';
    const key = mapped ? 'mapped' : 'pending';
    const group = groups.get(key) ?? { key, mapped, items: [] };
    group.items.push(alias);
    groups.set(key, group);
  }
  // Undecided first: that is the list with work left in it.
  const order = (key: string): number => (key === 'pending' ? 0 : 1);
  return [...groups.values()].sort((left, right) => order(left.key) - order(right.key));
});

async function loadAliases(): Promise<void> {
  try {
    // This page is about Tag names, so it asks for that vocabulary alone: the server returns the
    // library's own tags for it, and the author dictionary has its own page.
    aliases.value = await props.api.listTaxonomyAliases('entry');
    error.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('advanced.loadError');
  }
}

async function saveAlias(): Promise<void> {
  const request: UpsertTaxonomyAliasRequest = {
    vocabulary: 'entry',
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

/**
 * 无需映射: this name is decided — it stays exactly as it is.
 *
 * A dictionary is a list of names that need a *decision*, and "no decision needed" is an answer: `2B`
 * is a character's name in every language it appears in, and a mapping from it to itself would say
 * nothing while sitting in the queue for ever. Answering removes the row, so the name leaves the
 * queue and resolution returns it unchanged — which is what leaving it alone already meant.
 *
 * It is not filed under "mapped": a row that maps a name to itself is not a mapping, and the built-in
 * Traditional → Simplified conversion already covers the one case where a name really does change.
 */
async function keepAsIs(alias: TaxonomyAliasDto): Promise<void> {
  busy.value = true;
  error.value = null;
  importSummary.value = '';
  try {
    await props.api.deleteTaxonomyAlias(alias.id);
    await loadAliases();
    importSummary.value = t('taxonomy.keptAsIs', { alias: alias.alias });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('taxonomy.deleteError');
  } finally {
    busy.value = false;
  }
}

/**
 * 把各站点的字典一次搬进来 — the one-time move off the tool's export tree.
 *
 * Every crawl has been writing a dictionary per site all along, and the only way to use one was to
 * find the file and hand it over — which stopped happening when a work began going from a crawl to
 * the library without a person opening anything in between. This reads them all from the tool's own
 * home; after it runs the alias table is the dictionary.
 */
async function importSiteDictionaries(): Promise<void> {
  busy.value = true;
  importSummary.value = '';
  error.value = null;
  try {
    const result = await props.api.importSiteDictionaries();
    importSummary.value = t('taxonomy.siteDictionariesImported', {
      sites: result.sites,
      count: result.imported,
      pending: result.pending,
      rewritten: result.rewritten,
      conflicts: result.conflicts.length,
    });
    await loadAliases();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('taxonomy.importError');
  } finally {
    busy.value = false;
  }
}

/** Loads a placeholder row (imported name, no canonical yet) into the form. */
function startFill(alias: TaxonomyAliasDto): void {
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
    // A dictionary is thousands of pairs, so what it could not write is reported rather than thrown:
    // one pair the library contradicts must not take the rest with it.
    const written = await props.api.importTaxonomyAliases({ aliases: rows });
    const pending = written.aliases.filter((alias) => alias.canonicalName === '').length;
    importSummary.value = t('taxonomy.imported', {
      count: written.aliases.length,
      pending,
      skipped: written.skipped.length,
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
// ---------------------------------------------------------------------------
// Title shortening: reviewed list of `<original> | <translation>` titles.
// One decision per Entry: which side to keep. Prefilled from the plan's
// suggestion, left empty when the plan could not infer a direction.
// ---------------------------------------------------------------------------
const titleBusy = ref(false);
const titlePlan = ref<TitleShorteningPlanResponse | null>(null);
const titleResult = ref<ApplyTitleShorteningResponse | null>(null);
const titleError = ref<string | null>(null);
const titleChoices = ref<Record<number, TitleShorteningSide | null>>({});

const chosenTitleChanges = computed<TitleShorteningChange[]>(() => {
  const candidates = titlePlan.value?.candidates ?? [];
  return candidates.flatMap((candidate) => {
    const side = titleChoices.value[candidate.entryId] ?? null;
    if (side === null) return [];
    return [{
      entryId: candidate.entryId,
      title: candidate.title,
      shortenedTitle: side === 'front' ? candidate.keepFront : candidate.keepBack,
    }];
  });
});

async function loadTitlePlan(): Promise<void> {
  titleBusy.value = true;
  titleError.value = null;
  titleResult.value = null;
  try {
    titlePlan.value = await props.api.planTitleShortening();
    const choices: Record<number, TitleShorteningSide | null> = {};
    for (const candidate of titlePlan.value.candidates) {
      choices[candidate.entryId] = candidate.suggested;
    }
    titleChoices.value = choices;
  } catch (cause) {
    titleError.value = cause instanceof Error ? cause.message : t('title.planError');
  } finally {
    titleBusy.value = false;
  }
}

async function applyTitleShorteningChanges(): Promise<void> {
  const changes = chosenTitleChanges.value;
  if (changes.length === 0) return;
  // Destructive bulk edit: the first tap only arms the button.
  if (!arm('apply-title-shortening')) return;
  disarm('apply-title-shortening');
  titleBusy.value = true;
  titleError.value = null;
  try {
    titleResult.value = await props.api.applyTitleShortening(changes);
    titlePlan.value = null;
    titleChoices.value = {};
    emit('works-changed');
  } catch (cause) {
    titleError.value = cause instanceof Error ? cause.message : t('title.applyError');
  } finally {
    titleBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Tag merge: one kept tag absorbs the others — assignments move, merged tag
// rows are deleted outright (old names have no retrieval value, unlike author
// alternates). Inputs use the relation autocomplete in id-only mode: a merge
// needs real, existing tags.
// ---------------------------------------------------------------------------
interface TagMergePick {
  id: number;
  name: string;
}
const mergeKept = ref<TagMergePick | null>(null);
const mergeMerged = ref<TagMergePick[]>([]);
const tagMergeBusy = ref(false);
const tagMergeNotice = ref('');
const tagMergeError = ref<string | null>(null);
const tagMergeFormKey = ref(0);

// Tag delete: the merge's counterpart for a tag that should not be in the
// collection at all. Same Entry-vocabulary scope as the merge above and the same
// arm-then-confirm, because this also destroys data — except that a merge keeps a
// name alive and a delete does not, so the confirmation states the count of uses
// that go with it.
const deletePick = ref<TagMergePick | null>(null);
const tagDeleteBusy = ref(false);
const tagDeleteNotice = ref('');
const tagDeleteError = ref<string | null>(null);
const tagDeleteFormKey = ref(0);

function pickDeleteTag(suggestion: TagMergePick): void {
  deletePick.value = { id: suggestion.id, name: suggestion.name };
}

function removeDeletePick(): void {
  deletePick.value = null;
}

/**
 * Deleting the *tag* from a catalog row: the same call the form below makes, with the same
 * two-step arm, because a tag goes off every work that carries it. A row that came from the
 * library has no alias row to remove — the row's × is not what this is — so the two are labelled
 * differently rather than sharing one button that means two things.
 */
async function deleteCatalogTag(alias: { tagId?: number | null | undefined; alias: string }): Promise<void> {
  const tagId = alias.tagId;
  if (tagId === null || tagId === undefined) return;
  const key = `delete-tag-${tagId}`;
  if (!arm(key)) return;
  disarm(key);
  tagDeleteBusy.value = true;
  tagDeleteError.value = null;
  tagDeleteNotice.value = '';
  try {
    const result = await props.api.deleteTag({ vocabulary: 'entry', tagId });
    tagDeleteNotice.value = t('tagDelete.done', { tag: result.tagName, n: result.removedAssignments });
    await loadAliases();
  } catch (cause) {
    tagDeleteError.value = cause instanceof Error ? cause.message : t('tagDelete.error', { tag: alias.alias });
  } finally {
    tagDeleteBusy.value = false;
  }
}

async function applyTagDelete(): Promise<void> {
  if (deletePick.value === null) return;
  if (!arm('delete-tag')) return;
  disarm('delete-tag');
  tagDeleteBusy.value = true;
  tagDeleteError.value = null;
  tagDeleteNotice.value = '';
  const name = deletePick.value.name;
  try {
    const result = await props.api.deleteTag({ vocabulary: 'entry', tagId: deletePick.value.id });
    tagDeleteNotice.value = t('tagDelete.done', { tag: result.tagName, n: result.removedAssignments });
    deletePick.value = null;
    tagDeleteFormKey.value += 1;
    // The dictionary view is keyed by name, so a deleted tag must not linger there.
    await loadAliases();
  } catch (cause) {
    tagDeleteError.value = cause instanceof Error ? cause.message : t('tagDelete.error', { tag: name });
  } finally {
    tagDeleteBusy.value = false;
  }
}

function suggestEntryTagsForMerge(query: string, excludeIds: number[], signal: AbortSignal) {
  return props.api.suggestTags({
    vocabulary: 'entry',
    q: query,
    excludeIds,
    includeNsfw: String(showNsfw.value) as 'true' | 'false',
  }, signal);
}

function pickMergeKept(suggestion: RelationSuggestion): void {
  mergeMerged.value = mergeMerged.value.filter((pick) => pick.id !== suggestion.id);
  mergeKept.value = { id: suggestion.id, name: suggestion.name };
}

function pickMergeMerged(suggestion: RelationSuggestion): void {
  if (mergeKept.value?.id === suggestion.id) return;
  if (mergeMerged.value.some((pick) => pick.id === suggestion.id)) return;
  mergeMerged.value.push({ id: suggestion.id, name: suggestion.name });
}

function removeMergeMerged(id: number): void {
  mergeMerged.value = mergeMerged.value.filter((pick) => pick.id !== id);
}

function removeMergeKept(): void {
  mergeKept.value = null;
}

async function applyTagMerge(): Promise<void> {
  if (mergeKept.value === null || mergeMerged.value.length === 0) return;
  if (!arm('apply-tag-merge')) return;
  disarm('apply-tag-merge');
  tagMergeBusy.value = true;
  tagMergeNotice.value = '';
  tagMergeError.value = null;
  error.value = null;
  try {
    const result = await props.api.mergeTag({
      vocabulary: 'entry',
      keptTagId: mergeKept.value.id,
      mergedTagIds: mergeMerged.value.map((pick) => pick.id),
    });
    tagMergeNotice.value = t('tagMerge.notice', {
      moved: String(result.movedAssignments),
      skipped: String(result.skippedDuplicates),
      deleted: String(result.deletedTags),
    });
    mergeKept.value = null;
    mergeMerged.value = [];
    tagMergeFormKey.value += 1; // rebuild the autocomplete inputs
    await loadAliases();
    emit('works-changed');
  } catch (cause) {
    tagMergeError.value = cause instanceof Error ? cause.message : t('tagMerge.error');
  } finally {
    tagMergeBusy.value = false;
  }
}

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

const authorMergeArmed = computed(() => plan.value !== null && plan.value.plans.length > 0);

/** One compact button: first tap plans (finds duplicate groups), second tap
 * executes. Deliberately small — the merge itself is a single action. */
async function authorMergeButton(): Promise<void> {
  if (!authorMergeArmed.value) {
    await loadPlan();
    return;
  }
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
const authorAliasFormKey = ref(0);

/** Relation suggestions while typing alias names: existing Authors and their
 * identity aliases (e.g. typing "kaise dake" offers "kaise_dake"). */
function suggestProducersForAlias(query: string, excludeIds: number[], signal: AbortSignal) {
  return props.api.suggestProducers({ q: query, excludeIds }, signal);
}

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
  // A real click on Save blurs the focused input first (commit-on-blur writes
  // its value); do the same explicitly so keyboard flows are equally safe.
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
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
    authorAliasFormKey.value += 1; // rebuild the autocomplete inputs
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

// ---- System (the lowest-level page) ----------------------------------------------------------
// Nothing here is part of the library API: these are the desktop's own endpoints, called
// directly, and every one of them is about the machine T³ runs on.
const diagnostics = ref<SystemDiagnostics | null>(null);
const pairingDiagnostics = ref<unknown>(null);
const backups = ref<BackupEntry[]>([]);
const settings = ref<SystemSettings | null>(null);
const stagedRestore = ref<StagedRestore | null>(null);
const systemBusy = ref(false);
const systemError = ref('');
const systemNotice = ref('');
const restoreFileName = ref('');

function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The report is the server's own words first, then what this page has seen go wrong. */
const reportText = computed(() => {
  const lines: string[] = [];
  const info = diagnostics.value;
  lines.push(`T3 diagnostics · ${new Date().toISOString()}`);
  if (info === null) {
    lines.push(t('system.reportNoServer'));
  } else {
    lines.push(`build: ${info.platform} · node ${info.nodeVersion}`);
    lines.push(`data: ${info.dataDir}`);
    lines.push(`database: ${info.databasePath ?? '(none)'}`);
    lines.push(`backups: ${info.backupCount} in ${info.backupsDir}`);
    lines.push(`${t('system.reportSettings')} ${info.settingsPath}${info.settingsProblem === null ? '' : ` (${t('system.reportUnreadable')} ${info.settingsProblem})`}`);
    if (info.stagedRestore !== null) {
      lines.push(t('system.reportStaged', { at: info.stagedRestore.stagedAt }));
    }
    lines.push(`log: ${info.logPath} (${bytesText(info.logBytes)}${info.logTruncated ? ', showing the tail' : ''})`);
    lines.push('');
    lines.push('--- server log (tail) ---');
    lines.push(info.logTail.trim() === '' ? t('system.reportLogEmpty') : info.logTail.trimEnd());
  }
  const errors = clientErrors();
  lines.push('');
  lines.push(`--- page errors since load (${errors.length}) ---`);
  lines.push(errors.length === 0
    ? '(none)'
    : errors.map((row) => `${row.at} [${row.kind}] ${row.message}${row.source === null ? '' : ` (${row.source})`}`).join('\n'));
  lines.push('');
  lines.push(`--- page ---`);
  lines.push(`user agent: ${navigator.userAgent}`);
  lines.push(`viewport: ${globalThis.innerWidth}x${globalThis.innerHeight} @${globalThis.devicePixelRatio}x`);
  lines.push(`browser compatibility: ${JSON.stringify(browserCompatibilityReport())}`);
  lines.push('--- native pairing ---');
  lines.push(JSON.stringify(pairingDiagnostics.value, null, 2));
  return lines.join('\n');
});

async function loadSystem(): Promise<void> {
  systemBusy.value = true;
  systemError.value = '';
  // Read independently: an unpaired phone cannot fetch desktop diagnostics.
  pairingDiagnostics.value = await readNativePairingDiagnostics();
  try {
    diagnostics.value = await fetchSystemDiagnostics();
    stagedRestore.value = diagnostics.value.stagedRestore;
    settings.value = diagnostics.value.settings;
    backups.value = await fetchBackups();
  } catch (cause) {
    systemError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    systemBusy.value = false;
  }
}

async function copyReport(): Promise<void> {
  systemError.value = '';
  try {
    pairingDiagnostics.value = await readNativePairingDiagnostics();
    await copyText(reportText.value);
    systemNotice.value = t('system.copied');
  } catch (cause) {
    systemError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function backupNow(): Promise<void> {
  systemBusy.value = true;
  systemError.value = '';
  systemNotice.value = '';
  try {
    const created = await createBackup();
    systemNotice.value = t('system.backupCreated', { name: created.name, size: bytesText(created.bytes) });
    backups.value = await fetchBackups();
  } catch (cause) {
    systemError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    systemBusy.value = false;
  }
}

async function exportBackup(name: string): Promise<void> {
  systemError.value = '';
  try {
    await downloadBackup(name);
  } catch (cause) {
    systemError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function deleteBackup(name: string): Promise<void> {
  systemBusy.value = true;
  systemError.value = '';
  try {
    await removeBackup(name);
    backups.value = await fetchBackups();
  } catch (cause) {
    systemError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    systemBusy.value = false;
  }
}

function chooseRestoreFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  restoreFileName.value = input.files?.[0]?.name ?? '';
}

async function uploadRestore(): Promise<void> {
  const input = restoreInput.value;
  const file = input?.files?.[0];
  if (file === undefined) return;
  systemBusy.value = true;
  systemError.value = '';
  systemNotice.value = '';
  try {
    const result = await stageRestore(file);
    stagedRestore.value = result.staged;
    systemNotice.value = t('system.restoreStaged');
    if (input !== null) input.value = '';
    restoreFileName.value = '';
  } catch (cause) {
    systemError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    systemBusy.value = false;
  }
}

async function setAutoMobile(value: boolean): Promise<void> {
  systemError.value = '';
  systemNotice.value = '';
  try {
    settings.value = await saveSystemSettings({ autoAllowMobileConnection: value });
    systemNotice.value = value ? t('system.autoMobileOn') : t('system.autoMobileOff');
  } catch (cause) {
    systemError.value = cause instanceof Error ? cause.message : String(cause);
    // The switch follows the server, not the click: put it back where it was.
    settings.value = settings.value === null ? null : { ...settings.value };
  }
}

const restoreInput = ref<HTMLInputElement | null>(null);

watch(tab, (value) => {
  if (value === 'system' && diagnostics.value === null) {
    void loadSystem();
  }
}, { immediate: true });

watch(tab, (value) => {
  if (value === 'templates' && !templatesLoaded.value) {
    void props.api.commonTemplate()
      .then((template) => { commonTemplate.value = template; })
      // A failure here hides the block, which reads as "this app has none" — so leave a trace: a
      // server too old to answer (or one that refuses the file) is a thing to see in the console,
      // not a blank space to wonder about.
      .catch((cause: unknown) => {
        commonTemplate.value = null;
        console.warn('Common template unavailable', cause);
      });
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

    <nav class="advanced-tabs" :aria-label="t('advanced.title')">
      <button
        data-testid="advanced-tab-tags"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'tags' }"
        @click="tab = 'tags'"
      >
        {{ t('advanced.tagsTab') }}
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
        data-testid="advanced-tab-sources"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'sources' }"
        @click="tab = 'sources'"
      >
        {{ t('advanced.sourcesTab') }}
      </button>
      <button
        data-testid="advanced-tab-offline"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'offline' }"
        @click="tab = 'offline'"
      >
        {{ t('offline.title') }}
      </button>
      <button
        data-testid="advanced-tab-system"
        class="secondary-button"
        type="button"
        :class="{ active: tab === 'system' }"
        @click="tab = 'system'"
      >
        {{ t('system.title') }}
      </button>
    </nav>

    <p v-if="error" class="error-message" role="alert">{{ error }}</p>

    <!-- The offline copy is a function of this page, not a quick setting: the
         Settings sheet keeps only what belongs to a fast daily pass. -->
    <section v-if="tab === 'offline'" data-testid="advanced-offline" class="advanced-card">
      <OfflineLibrarySettings
        :api="api"
        :store="store"
        :online="online"
        :copy-revision="offlineCopyRevision ?? null"
        @updated="emit('updated')"
      >
        <template #diagnostics><slot name="offline-diagnostics" /></template>
      </OfflineLibrarySettings>
    </section>

    <section v-if="tab === 'tags'" data-testid="advanced-tags" class="advanced-card">
      <h3>{{ t('taxonomy.title') }}</h3>
      <p class="muted">{{ t('taxonomy.hint') }}</p>

      <div class="dictionary-import">
        <button
          data-testid="taxonomy-import-site-dictionaries"
          class="secondary-button"
          type="button"
          :disabled="busy"
          @click="importSiteDictionaries"
        >
          {{ t('taxonomy.importSiteDictionaries') }}
        </button>
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
      </div>
      <p v-if="importSummary" class="muted" data-testid="taxonomy-import-summary">
        {{ importSummary }}
      </p>

      <form data-testid="taxonomy-alias-form" class="alias-form" @submit.prevent="saveAlias">
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
          :data-testid="`taxonomy-group-${group.key}`"
          :aria-expanded="expandedGroups.has(group.key)"
          @click="toggleGroup(group.key)"
        >
          <span class="alias-group-title t3-library-text">
            <span class="alias-caret" aria-hidden="true">{{ expandedGroups.has(group.key) ? '▾' : '▸' }}</span>
            {{ aliasGroupLabel(group.mapped) }}
            <small>{{ group.items.length }}</small>
          </span>
        </button>
        <ul v-if="expandedGroups.has(group.key)" data-testid="taxonomy-alias-list" class="taxonomy-alias-list">
          <li v-for="alias in group.items" :key="`${alias.tagId ? 'tag' : 'alias'}-${alias.id}`">
                    <span class="alias-name t3-library-text">
              {{ alias.alias }} →
              <em v-if="alias.canonicalName === ''" class="alias-placeholder">
                {{ t('taxonomy.placeholder') }}
              </em>
              <template v-else>{{ alias.canonicalName }}</template>
            </span>
            <!-- The row's actions as one group, so a phone can put them on their own line instead
                 of squeezing the name into the few characters the buttons leave it. -->
            <span class="alias-actions">
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
              v-if="alias.canonicalName === ''"
              type="button"
              class="alias-action"
              :disabled="busy"
              :title="t('taxonomy.keepAsIsHint')"
              :data-testid="`taxonomy-keep-${alias.id}`"
              @click="keepAsIs(alias)"
            >
              {{ t('taxonomy.keepAsIs') }}
            </button>
            <button
              v-if="alias.tagId"
              type="button"
              class="alias-action delete-tag-action"
              :class="{ 'armable-armed': armedKey === `delete-tag-${alias.tagId}` }"
              :disabled="busy || tagDeleteBusy"
              :title="t('taxonomy.deleteTagHint')"
              :data-testid="`taxonomy-delete-tag-${alias.tagId}`"
              @click="deleteCatalogTag(alias)"
            >
              {{ armedKey === `delete-tag-${alias.tagId}` ? t('tagDelete.applyConfirm') : t('taxonomy.deleteTag') }}
            </button>
            <button
              v-if="!alias.tagId"
              type="button"
              class="remove-tag-button"
              :disabled="busy"
              :aria-label="t('taxonomy.deleteAlias', { alias: alias.alias })"
              @click="removeAlias(alias.id)"
            >×</button>
            </span>
          </li>
        </ul>
      </div>
      <p v-if="onlyUnmatched && visibleGroups.length === 0" class="muted" data-testid="taxonomy-no-unmatched">
        {{ t('taxonomy.noUnmatched') }}
      </p>

      <div :key="tagMergeFormKey" class="tag-merge-panel" data-testid="tag-merge-form">
        <h4>{{ t('tagMerge.title') }}</h4>
        <p class="muted">{{ t('tagMerge.hint') }}</p>
        <div class="tag-merge-row">
          <span class="tag-merge-label">{{ t('tagMerge.kept') }}</span>
                <span v-if="mergeKept !== null" class="author-alias-chip t3-library-text">
            {{ mergeKept.name }}
            <button
              type="button"
              class="remove-tag-button"
              :aria-label="t('tag.removeSelection')"
              data-testid="tag-merge-kept-remove"
              @click="removeMergeKept"
            >×</button>
          </span>
          <SuggestionInput
            v-else
            mode="id-only"
            name="tagMergeKept"
            :provider="suggestEntryTagsForMerge"
            :exclude-ids="mergeMerged.map((pick) => pick.id)"
            :aria-label="t('tagMerge.kept')"
            :placeholder="t('suggestion.searchPlaceholder')"
            @select="pickMergeKept"
          />
        </div>
        <div class="tag-merge-row">
          <span class="tag-merge-label">{{ t('tagMerge.merged') }}</span>
          <span
            v-for="pick in mergeMerged"
            :key="pick.id"
            class="author-alias-chip t3-library-text"
            :data-testid="`tag-merge-pick-${pick.id}`"
          >
            {{ pick.name }}
            <button
              type="button"
              class="remove-tag-button"
              :aria-label="t('tag.removeSelection')"
              :data-testid="`tag-merge-remove-${pick.id}`"
              @click="removeMergeMerged(pick.id)"
            >×</button>
          </span>
          <SuggestionInput
            mode="id-only"
            name="tagMergeMerged"
            :provider="suggestEntryTagsForMerge"
            :exclude-ids="[...(mergeKept === null ? [] : [mergeKept.id]), ...mergeMerged.map((pick) => pick.id)]"
            :aria-label="t('tagMerge.merged')"
            :placeholder="t('suggestion.searchPlaceholder')"
            @select="pickMergeMerged"
          />
        </div>
        <button
          type="button"
          class="primary-button tag-merge-apply"
          :class="{ 'armable-armed': armedKey === 'apply-tag-merge' }"
          :disabled="tagMergeBusy || mergeKept === null || mergeMerged.length === 0"
          data-testid="tag-merge-apply"
          @click="applyTagMerge"
        >
          {{ armedKey === 'apply-tag-merge' ? t('tagMerge.applyConfirm') : t('tagMerge.apply') }}
        </button>
        <p
          v-if="tagMergeError"
          class="merge-integrity merge-integrity-fail"
          data-testid="tag-merge-error"
          role="alert"
        >
          {{ tagMergeError }}
        </p>
        <p
          v-if="tagMergeNotice"
          class="merge-integrity merge-integrity-pass"
          data-testid="tag-merge-notice"
          role="status"
        >
          {{ tagMergeNotice }}
        </p>
      </div>

      <div :key="tagDeleteFormKey" class="tag-merge-panel" data-testid="tag-delete-form">
        <h4>{{ t('tagDelete.title') }}</h4>
        <p class="muted">{{ t('tagDelete.hint') }}</p>
        <div class="tag-merge-row">
          <span class="tag-merge-label">{{ t('tagDelete.pick') }}</span>
              <span v-if="deletePick !== null" class="author-alias-chip t3-library-text" data-testid="tag-delete-pick">
            {{ deletePick.name }}
            <button
              type="button"
              class="remove-tag-button"
              :aria-label="t('tag.removeSelection')"
              data-testid="tag-delete-pick-remove"
              @click="removeDeletePick"
            >×</button>
          </span>
          <SuggestionInput
            v-else
            mode="id-only"
            name="tagDeletePick"
            :provider="suggestEntryTagsForMerge"
            :exclude-ids="[]"
            :aria-label="t('tagDelete.pick')"
            :placeholder="t('suggestion.searchPlaceholder')"
            @select="pickDeleteTag"
          />
        </div>
        <button
          type="button"
          class="primary-button tag-merge-apply"
          :class="{ 'armable-armed': armedKey === 'delete-tag' }"
          :disabled="tagDeleteBusy || deletePick === null"
          data-testid="tag-delete-apply"
          @click="applyTagDelete"
        >
          {{ armedKey === 'delete-tag' ? t('tagDelete.applyConfirm') : t('tagDelete.apply') }}
        </button>
        <p
          v-if="tagDeleteError"
          class="merge-integrity merge-integrity-fail"
          data-testid="tag-delete-error"
          role="alert"
        >
          {{ tagDeleteError }}
        </p>
        <p
          v-if="tagDeleteNotice"
          class="merge-integrity merge-integrity-pass"
          data-testid="tag-delete-notice"
          role="status"
        >
          {{ tagDeleteNotice }}
        </p>
      </div>

    </section>
    <section v-else-if="tab === 'templates'" data-testid="advanced-templates" class="advanced-card">
      <h3>{{ t('advanced.templatesTab') }}</h3>
      <p class="muted">{{ t('templates.hint') }}</p>
      <div v-if="commonTemplate" class="alias-group" data-testid="advanced-common-template">
        <div class="alias-group-header">
          <span class="alias-group-title t3-library-text">
            {{ t('templates.commonTitle') }}
            <small>{{ t('templates.sectionsCount', { count: String(commonTemplate.sections.length) }) }}</small>
          </span>
        </div>
        <div class="gallery-template-body">
          <p class="muted">{{ t('templates.commonHint') }}</p>
          <ul class="common-template-sections">
            <li v-for="section in commonTemplate.sections" :key="section.name" class="t3-library-text">
              {{ section.name }}<span v-if="section.facets.length > 0">: {{ section.facets.join(' / ') }}</span>
            </li>
            <li v-if="commonTemplate.ratingSlots.length > 0" class="t3-library-text">
              {{ t('templates.commonRatings') }}: {{ commonTemplate.ratingSlots.join(' / ') }}
            </li>
            <li class="t3-library-text">
              {{ t('templates.commonContentKinds') }}: {{ DEFAULT_CONTENT_KINDS.join(' / ') }}
            </li>
          </ul>
        </div>
      </div>
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
          <span class="alias-group-title t3-library-text">
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
                <span class="template-preview-section-name t3-library-text">{{ section.name }}</span>
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
                  <span class="template-preview-facet-label t3-library-text">{{ slot.name }}</span>
                  <span class="template-preview-stars">★★★★★</span>
                </div>
                <span v-if="(templateRatingSlots[summary.entryType] ?? []).length === 0" class="template-preview-empty">
                  {{ t('templates.noRatingSlots') }}
                </span>
              </div>
            </div>
            <div
              class="template-preview-section"
              :data-testid="`gallery-template-preview-content-${summary.entryType}`"
            >
              <span class="template-preview-section-name">{{ t('author.content') }}</span>
              <div class="template-preview-facet-rows">
                <!--
                  One row per Content kind a work of this Gallery carries. The first ones are the
                  built-ins every Gallery has (`source url`, the work's address, and `description`, its
                  synopsis); the rest are the kinds its works actually use, including whatever the
                  person added on a single work. A work shows a row only when it has text for it, so
                  this is a vocabulary of slots rather than rows somebody has to fill.
                -->
                <div
                  v-for="kind in summary.contentKinds"
                  :key="`${summary.entryType}-content-${kind}`"
                  class="template-preview-facet-row"
                >
                  <span class="template-preview-facet-label t3-library-text">{{ kind }}</span>
                  <span class="template-preview-facet-slot" />
                </div>
              </div>
              <p class="muted" :data-testid="`gallery-template-content-kinds-${summary.entryType}`">
                {{ t('templates.contentKinds', { count: String(summary.contentKinds.length) }) }}
              </p>
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

      <div data-testid="advanced-titles" class="advanced-subcard">
        <h4>{{ t('advanced.titlesTab') }}</h4>
        <p class="muted">{{ t('title.hint') }}</p>

        <div class="merge-actions">
          <button
            data-testid="title-plan-button"
            class="secondary-button"
            type="button"
            :disabled="titleBusy"
            @click="loadTitlePlan"
          >
            {{ titleBusy ? t('title.planning') : t('title.plan') }}
          </button>
        </div>

        <p v-if="titlePlan && titlePlan.candidates.length === 0" class="muted">
          {{ t('title.noCandidates') }}
        </p>
        <ul v-if="titlePlan" class="merge-list">
          <li
            v-for="(candidate, index) in titlePlan.candidates"
            :key="candidate.entryId"
            :data-testid="`title-plan-item-${index}`"
          >
                  <p class="title-current t3-library-text" :data-testid="`title-current-${index}`">{{ candidate.title }}</p>
            <div class="title-side-picker">
              <button
                type="button"
                class="title-side-button"
                :class="{ active: titleChoices[candidate.entryId] === 'front' }"
                :data-testid="`title-keep-front-${index}`"
                @click="titleChoices[candidate.entryId] = 'front'"
              >
                {{ candidate.keepFront }}
                <small>{{ t('title.keepFront') }}</small>
              </button>
              <button
                type="button"
                class="title-side-button"
                :class="{ active: titleChoices[candidate.entryId] === 'back' }"
                :data-testid="`title-keep-back-${index}`"
                @click="titleChoices[candidate.entryId] = 'back'"
              >
                {{ candidate.keepBack }}
                <small>{{ t('title.keepBack') }}</small>
              </button>
              <small
                v-if="candidate.suggested === null && titleChoices[candidate.entryId] === null"
                class="title-side-note"
                :data-testid="`title-undecided-${index}`"
              >
                {{ t('title.undecided') }}
              </small>
            </div>
          </li>
        </ul>

        <button
          v-if="chosenTitleChanges.length > 0"
          data-testid="title-apply-button"
          class="secondary-button danger-button"
          :class="{ 'armable-armed': armedKey === 'apply-title-shortening' }"
          type="button"
          :disabled="titleBusy"
          @click="applyTitleShorteningChanges"
        >
          {{ titleBusy
            ? t('title.applying')
            : armedKey === 'apply-title-shortening'
              ? t('title.confirmShort', { count: String(chosenTitleChanges.length) })
              : t('title.apply', { count: String(chosenTitleChanges.length) }) }}
        </button>
        <p v-if="titleError" class="merge-integrity merge-integrity-fail" role="alert">{{ titleError }}</p>
        <section v-if="titleResult" data-testid="title-result" class="merge-result">
          <h4>{{ t('title.resultHeading') }}</h4>
          <p data-testid="title-totals">{{ t('title.totals', {
            shortened: String(titleResult.shortenedCount),
            skipped: String(titleResult.skippedCount),
          }) }}</p>
          <p v-if="titleResult.backupPath" class="muted" data-testid="title-backup">
            {{ t('merge.backupPath', { path: titleResult.backupPath }) }}
          </p>
        </section>
      </div>
    </section>

    <section v-else-if="tab === 'authors'" data-testid="advanced-authors" class="advanced-card">
      <h3>{{ t('advanced.authorsTab') }}</h3>
      <p class="muted">{{ t('authorAlias.hint') }}</p>

      <section data-testid="author-merge-compact" class="alias-form">
        <h4>{{ t('advanced.mergeTab') }}</h4>
        <button
          data-testid="merge-run-button"
          class="primary-button"
          :class="{ 'armable-armed': armedKey === 'run-merge' }"
          type="button"
          :disabled="mergeBusy"
          @click="authorMergeButton"
        >
          {{ mergeBusy
            ? t('merge.executing')
            : authorMergeArmed
              ? t('merge.confirmRunShort', { count: String(plan?.plans.length ?? 0) })
              : t('merge.execute') }}
        </button>
        <p v-if="plan && plan.plans.length === 0" class="muted">{{ t('merge.noPlans') }}</p>
        <p v-if="plan && plan.plans.length > 0" class="muted" data-testid="merge-plan-summary">
          {{ t('merge.planSummary', { count: String(plan.plans.length) }) }}
        </p>
        <details v-if="plan && plan.plans.length > 0">
          <summary class="muted">{{ t('merge.planDetails') }}</summary>
          <ul data-testid="merge-plan-list" class="merge-list">
            <li
              v-for="(item, index) in plan.plans"
              :key="`${item.keeper.id}-${item.keeper.name}`"
              :data-testid="`merge-plan-item-${index}`"
            >
              {{ planLine(item) }}
            </li>
          </ul>
        </details>

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
              : t('merge.integrityFail') }}
          </p>
        </section>
      </section>
      <p v-if="aliasGroupNotice" class="merge-integrity merge-integrity-pass" data-testid="author-alias-notice" role="status">
        {{ aliasGroupNotice }}
      </p>

      <form
        :key="authorAliasFormKey"
        data-testid="author-alias-form"
        class="alias-form"
        @submit.prevent="saveAuthorAliasGroup"
      >
        <label>
          {{ t('authorAlias.displayName') }}
          <SuggestionInput
            mode="creatable-text"
            select-fills-input
            commit-on-blur
            name="authorAliasDisplayName"
            :provider="suggestProducersForAlias"
            :aria-label="t('authorAlias.displayName')"
            :placeholder="t('authorAlias.displayNamePlaceholder')"
            @select="(suggestion) => (aliasDisplayName = suggestion.name)"
            @submit-text="(text) => (aliasDisplayName = text)"
          />
        </label>
        <div class="alias-tag-rows">
          <label v-for="(_name, index) in aliasTagNames" :key="`alias-tag-${index}`">
            {{ t('authorAlias.tagName') }}
            <span class="alias-tag-row">
              <SuggestionInput
                mode="creatable-text"
                select-fills-input
                commit-on-blur
                :name="`authorAliasTag${index}`"
                :provider="suggestProducersForAlias"
                :aria-label="t('authorAlias.tagName')"
                :data-testid="`author-alias-tag-${index}`"
                :placeholder="t('authorAlias.tagNamePlaceholder')"
                @select="(suggestion) => (aliasTagNames[index] = suggestion.name)"
                @submit-text="(text) => (aliasTagNames[index] = text)"
              />
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

      <!-- Collapsed by default, like every other list on this page: the groups are what you come
           back to check, not what you came to read, and an always-open list pushes the form that
           saves a new one off the screen. It starts closed on every visit, which is what "always
           collapsed" means here — the state lives with the page, not in storage. -->
      <button
        type="button"
        class="alias-group-header"
        data-testid="author-alias-groups-toggle"
        :aria-expanded="expandedGroups.has('author-alias-groups')"
        @click="toggleGroup('author-alias-groups')"
      >
        <span class="alias-group-title t3-library-text">
          <span class="alias-caret" aria-hidden="true">{{ expandedGroups.has('author-alias-groups') ? '▾' : '▸' }}</span>
          {{ t('authorAlias.groupsHeading') }}
          <small>{{ authorAliasGroups.length }}</small>
        </span>
      </button>
      <p v-if="authorAliasLoaded && authorAliasGroups.length === 0" class="muted" data-testid="author-alias-empty">
        {{ t('authorAlias.empty') }}
      </p>
      <ul v-if="expandedGroups.has('author-alias-groups')" data-testid="author-alias-group-list" class="merge-list">
        <li v-for="group in authorAliasGroups" :key="group.canonicalName" :data-testid="`author-alias-group-${group.canonicalName}`">
                <span class="unassigned-tag-name t3-library-text">
            {{ group.canonicalName }}
            <small v-if="group.producerName === null">{{ t('authorAlias.noProducer') }}</small>
          </span>
          <span class="author-alias-chips">
            <span v-for="alias in group.aliases" :key="alias.id" class="author-alias-chip t3-library-text">
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
    <!-- Part of the same exclusive chain: one tab renders at a time. -->
    <SourceMaintenancePanel
      v-else-if="tab === 'sources'"
      :api="props.api"
      @works-changed="emit('works-changed')"
    />

    <!-- Last on purpose: this is where someone goes when something is wrong, not a daily page. -->
    <section v-else-if="tab === 'system'" data-testid="advanced-system" class="advanced-card">
      <h3>{{ t('system.title') }}</h3>
      <p class="muted">{{ t('system.hint') }}</p>

      <div class="system-block">
        <h4>{{ t('system.errors') }}</h4>
        <div class="system-actions">
          <button
            data-testid="system-refresh"
            class="secondary-button"
            type="button"
            :disabled="systemBusy"
            @click="loadSystem"
          >
            {{ t('system.refresh') }}
          </button>
          <button data-testid="system-copy" class="secondary-button" type="button" @click="copyReport">
            {{ t('system.copy') }}
          </button>
        </div>
        <textarea
          data-testid="system-report"
          class="system-report"
          readonly
          rows="14"
          spellcheck="false"
          :value="reportText"
        />
      </div>

      <div class="system-block">
        <h4>{{ t('system.database') }}</h4>
        <p class="muted">{{ t('system.databaseHint') }}</p>
        <div class="system-actions">
          <button
            data-testid="system-backup"
            class="secondary-button"
            type="button"
            :disabled="systemBusy"
            @click="backupNow"
          >
            {{ t('system.backup') }}
          </button>
          <label class="system-restore">
            <span>{{ t('system.restorePick') }}</span>
            <input
              ref="restoreInput"
              data-testid="system-restore-file"
              type="file"
              accept=".db,application/vnd.sqlite3"
              @change="chooseRestoreFile"
            />
          </label>
          <button
            data-testid="system-restore-upload"
            class="secondary-button"
            type="button"
            :disabled="systemBusy || restoreFileName === ''"
            @click="uploadRestore"
          >
            {{ restoreFileName === '' ? t('system.restore') : t('system.restoreNamed', { name: restoreFileName }) }}
          </button>
        </div>

        <ul v-if="backups.length > 0" class="system-backups" data-testid="system-backups">
          <li v-for="backup in backups" :key="backup.name" :data-testid="`system-backup-${backup.name}`">
            <span class="system-backup-name">{{ backup.name }}</span>
            <small class="muted">
              {{ t('system.backupMeta', {
                entries: String(backup.entryCount ?? '?'),
                size: bytesText(backup.bytes),
                at: new Date(backup.createdAt).toLocaleString(),
              }) }}
            </small>
            <button
              class="secondary-button"
              type="button"
              :data-testid="`system-backup-export-${backup.name}`"
              @click="exportBackup(backup.name)"
            >
              {{ t('system.export') }}
            </button>
            <button
              class="secondary-button"
              type="button"
              :disabled="systemBusy"
              :aria-label="t('system.deleteBackup')"
              :data-testid="`system-backup-delete-${backup.name}`"
              @click="deleteBackup(backup.name)"
            >
              ×
            </button>
          </li>
        </ul>
        <p v-else class="muted" data-testid="system-backups-empty">{{ t('system.noBackups') }}</p>

        <p
          v-if="stagedRestore"
          class="merge-integrity merge-integrity-fail"
          data-testid="system-restore-waiting"
        >
          {{ t('system.restoreWaiting', { at: new Date(stagedRestore.stagedAt).toLocaleString() }) }}
        </p>
      </div>

      <div class="system-block">
        <h4>{{ t('system.settings') }}</h4>
        <label class="system-toggle">
          <input
            data-testid="system-auto-mobile"
            type="checkbox"
            :checked="settings?.autoAllowMobileConnection ?? true"
            @change="setAutoMobile(($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t('system.autoMobile') }}</span>
        </label>
        <p class="muted">{{ t('system.autoMobileHint') }}</p>
      </div>

      <p v-if="systemError" class="error-message" role="alert" data-testid="system-error">{{ systemError }}</p>
      <p v-if="systemNotice" class="merge-integrity merge-integrity-pass" role="status" data-testid="system-notice">
        {{ systemNotice }}
      </p>
    </section>
  </section>
</template>

<style scoped>
.advanced-page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.25rem; container-type: inline-size; }
.advanced-toolbar { display: flex; align-items: center; gap: 1rem; }
.advanced-toolbar h2 { margin: 0; }
.advanced-tabs {
  display: flex;
  gap: 0.5rem;
  /* The row is wider than a phone: let it scroll instead of leaving tabs off-screen. */
  overflow-x: auto;
  min-width: 0;
  max-width: 100%;
  padding-bottom: 0.25rem;
  scrollbar-width: thin;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}
.advanced-tabs > button { flex: 0 0 auto; }
.advanced-subcard { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); }
.advanced-subcard > h4 { margin: 0 0 0.35rem; }
.system-block { margin-top: 1.1rem; padding-top: 0.9rem; border-top: 1px solid var(--border-subtle); }
.system-block:first-of-type { margin-top: 0.5rem; padding-top: 0; border-top: none; }
.system-block > h4 { margin: 0 0 0.35rem; }
.system-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0.5rem 0; }
.system-report {
  width: 100%;
  min-height: 12rem;
  margin-top: 0.4rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  background: var(--surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  line-height: 1.45;
  white-space: pre;
  overflow: auto;
  resize: vertical;
}
.system-restore { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; }
.system-restore input { max-width: 14rem; }
.system-backups { display: grid; gap: 0.4rem; margin: 0.4rem 0 0; padding: 0; list-style: none; }
.system-backups > li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--border-subtle); }
.system-backup-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
.system-backups > li > small { margin-right: auto; }
.system-toggle { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.3rem; }
.advanced-tabs .secondary-button.active { border-color: var(--accent); color: var(--accent); }
.advanced-card {
  display: grid;
  gap: 1rem;
  grid-template-columns: minmax(0, 1fr);
  overflow-wrap: anywhere;
  padding: 1.25rem;
  border: 1px solid var(--border-subtle);
  border-radius: 20px;
  background: var(--surface);
}
/* Intrinsic file/input widths must not enlarge the actual shell card. */
.advanced-card > *, .alias-form > *, .tag-merge-panel > * { min-width: 0; }
.advanced-card button, .advanced-card input, .advanced-card select { max-width: 100%; min-width: 0; box-sizing: border-box; }
.dictionary-import label { min-width: 0; max-width: 100%; }
.tag-merge-row > * { min-width: 0; max-width: 100%; }
.tag-merge-row :deep(.suggestion-input input) { min-width: 0; max-width: 100%; box-sizing: border-box; }
.author-alias-chip { overflow-wrap: anywhere; }
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
/* Tag merge has its own panel: .alias-form is a multi-column grid on wide
   screens (alias → canonical → save), which would scatter this module's rows. */
.tag-merge-panel {
  display: grid;
  gap: 0.7rem;
  justify-items: stretch;
  padding: 1rem;
  border-radius: 14px;
  background: var(--surface-muted);
}
.tag-merge-panel h4 { margin: 0; }
.tag-merge-panel .muted { margin: 0; font-size: 0.78rem; line-height: 1.5; }
.tag-merge-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.tag-merge-label { flex: 0 0 5.5rem; color: var(--text-muted); font-size: 0.78rem; font-weight: 700; }
.tag-merge-apply { justify-self: start; width: fit-content; }
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
  min-width: 0;
  overflow-wrap: anywhere;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.55rem;
  border-radius: 0.5rem;
  background: var(--surface-muted);
}
.alias-placeholder { color: var(--text-muted); opacity: 0.8; }
.alias-actions { display: flex; align-items: center; gap: 0.45rem; }
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
/* The dictionary import door: the button and the file control on one line, and the file control's
   own label can take a line of its own when there is no room. */
.dictionary-import { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
.dictionary-import label { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }

/* A grid item's automatic minimum size is its *content*, so one row that cannot shrink sets the width
   of the whole page. Measured on a 390px viewport: the five tab buttons laid the page out 510px wide
   (`right: 534`), the shell clipped the excess, and nothing scrolled — the last tab could not be
   reached at all. `min-width: 0` lets the items be narrower than their content, and the strip below
   gives the tabs somewhere to go. Either rule alone leaves the other half of the symptom. */
.advanced-page > * { min-width: 0; }

@container (max-width: 44rem) {
  .advanced-toolbar { flex-wrap: wrap; row-gap: 0.35rem; }
  /* The same shape the app's own tab strips use on a phone: one row that scrolls sideways, with the
     tabs at a touch-sized height, instead of a row wider than the screen. */
  .advanced-tabs {
    flex-wrap: nowrap;
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
  }
  .advanced-tabs .secondary-button { flex: 0 0 auto; min-height: 44px; }
  .advanced-card { padding: 0.9rem; }
  /* A name can be one long unbroken run; it wraps rather than pushing the row wide. */
  .alias-name { overflow-wrap: anywhere; }
  /* The name takes the line and the actions follow under it. Side by side there is no room for both:
     measured on a 390px viewport, the two buttons left the name a column about four characters wide
     ("Aemea th →"), which is the row's subject rendered unreadable. */
  .taxonomy-alias-list li { grid-template-columns: minmax(0, 1fr); gap: 0.35rem; }
  .alias-actions { justify-self: start; flex-wrap: wrap; }
  .alias-form { padding: 0.8rem; }
}

@container (min-width: 44rem) {
  .alias-form { grid-template-columns: minmax(7rem, 0.4fr) minmax(9rem, 0.5fr) minmax(0, 1fr) auto minmax(0, 1fr) auto; align-items: end; }
}
</style>
