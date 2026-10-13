<script setup lang="ts">
/**
 * The advanced import page: paste an address, pick what to read, run the tool, import what it got.
 *
 * The whole design follows from one decision the person is *not* asked to make: which tool, and
 * which site. The site is derived from the address, and the kinds of reading it offers are the ones
 * its adapters actually declare — so the page can say "rule found: 18comic.vip" or "no rule for this
 * site yet", and nothing about any site is written here (guidance §33).
 *
 * Three of its steps are the tool's own vocabulary mapped into four things a person recognises
 * (`work`, `search`, `album`, `playlist`): an artist page *is* a collection page, and a favourite
 * list *is* a playlist. Which of the four a site offers is whatever its files declare.
 *
 * What happens after the run is what the specification settled with the user:
 *
 * * one work → straight into the import review;
 * * several → the tool scans for review first (cards only — cheap), and the page asks whether to
 *   filter; "yes" opens the review page in a tab and follows the selection the person saves there,
 *   "no" runs again to read everything.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { copyText } from '../clipboard.js';

import type { GalleryApi } from '../api/gallery.js';
import { describeFindings, type ImportPreview, type SiteprobeSite, type SiteprobeTarget } from '@t3/shared';
import { useI18n, type MessageKey } from '../i18n.js';
import { siteForHost } from '../siteprobe/adapter-status.js';

const props = defineProps<{ api: GalleryApi }>();
const emit = defineEmits<{
  /** The export is ready to review as an import: the parent owns that screen. */
  preview: [payload: { preview: ImportPreview; source: 'path' }];
  /** No rule exists for this address: build one, starting from the address itself. */
  'build-rule': [url: string];
}>();

const { t } = useI18n();

/** The four things a person recognises, in the order the specification lists them. */
type UiKind = 'work' | 'search' | 'album' | 'playlist';

/**
 * How the tool's kinds are grouped for a person, by what the rule *reads* rather than by its name.
 *
 * The name is the site's, and sites disagree: 18comic calls a single work page `album`, while hitomi
 * calls its collection page `artist`. Reading the name alone offered 18comic's one-work rule as
 * "A collection" — measured in the browser on a real 18comic address. What decides is `single`: a
 * target that reads one work is one of the four "one work" rows however the site spells it, and only
 * the many-work targets are a collection.
 */
const UI_KINDS: readonly { key: UiKind; kinds: readonly string[]; single: boolean }[] = [
  { key: 'work', kinds: ['work', 'album'], single: true },
  { key: 'search', kinds: ['search'], single: false },
  { key: 'album', kinds: ['album', 'artist', 'folder'], single: false },
  { key: 'playlist', kinds: ['playlist', 'favorite'], single: false },
];

interface OfferedKind {
  key: UiKind;
  /** The tool kind the run will be asked for, once an address or keyword decides it. */
  targets: readonly string[];
  /** One work per run: a review step makes no sense, so the run goes straight to the download. */
  single: boolean;
  /** The input may be a bare name (a keyword, a creator) rather than an address. */
  acceptsName: boolean;
  /**
   * Which adapter layer answers this kind (`installed`, `local`, …). A site can carry two files for
   * one kind, and only one of them answers an address, so the row says which — shown only when there
   * is more than one file to choose between, where the answer is not knowable from the site alone.
   */
  sources: readonly string[];
  label: string;
  explanation: string;
}

const sites = ref<SiteprobeSite[]>([]);
const unavailable = ref<string | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
/** A refusal of the *input*: the page asks again instead of reporting a bug. */
const inputProblem = ref<string | null>(null);
/** The log an internal fault left behind, when the server wrote one. */
const errorLogPath = ref<string | null>(null);
const diagnosticsCopied = ref(false);

const INPUT_CODES = new Set(['INVALID_INPUT', 'NO_MATCH', 'AMBIGUOUS', 'UNKNOWN_SITE']);

/**
 * One failure, said three ways.
 *
 * `input` — the address or keyword was wrong, which the form asks about again. `run` — the tool
 * looked and gave a verdict (a bot check, a listing with nothing in it, a page with no title): the
 * person gets the tool's own sentence and no bug report. `bug` — a crash nobody planned for, which
 * gets the log path and the report request. Measured on a real run whose SSL handshake failed and
 * whose panel demanded a bug report for what was really a moment of the site refusing.
 */
const failure = computed(() => {
  if (!error.value) return null;
  const code = run.value?.error?.code;
  if (INPUT_CODES.has(code ?? '')) return { kind: 'input' as const, message: error.value };
  if (code === 'INTERNAL' || code === 'NOT_INSTALLED') {
    return { kind: 'bug' as const, message: error.value };
  }
  return { kind: 'run' as const, message: error.value };
});

/**
 * Why a stage produced nothing, in the tool's own words (plan §5-E).
 *
 * Read from the run's result or from the last `error` event, worst finding first, each with a next
 * step — so a run that read 0 cards says *which* stage read nothing instead of just "0 items". The
 * tool's sentences are already what this panel shows for a `run` failure, so a finding reads the same
 * way; nothing here is a second vocabulary.
 */
const runFindings = computed(() => {
  const fromResult = run.value?.result?.findings;
  if (fromResult && fromResult.length > 0) return describeFindings(fromResult);
  const lastError = [...(run.value?.events ?? [])].reverse()
    .find((event) => event.event === 'error' || event.event === 'review');
  return describeFindings(lastError?.event === 'error' || lastError?.event === 'review'
    ? lastError.findings : []);
});

const address = ref('');
const site = ref<SiteprobeSite | null>(null);
const noRule = ref(false);
const offered = ref<OfferedKind[]>([]);
const kind = ref<UiKind | null>(null);
const source = ref('');
const checklistInput = ref('');
const playlistNeedsLogin = ref(false);
const resolvedKind = ref<string | null>(null);

const run = ref<Awaited<ReturnType<GalleryApi['getSiteprobeRun']>> | null>(null);
/** The login job, when the person asked to sign in before the run. */
const signingIn = ref(false);
const loginDoneSent = ref(false);
const log = ref<string[]>([]);
const elapsed = ref(0);
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

/** The review page a multi-item run wrote, and whether the person chose to filter it. */
const reviewHtml = ref<string | null>(null);
const reviewCount = ref<number | null>(null);
const awaitingSelection = ref(false);

const selectionNotice = ref<string | null>(null);
const readme = ref<{ site: string; text: string } | null>(null);
const readmeOpen = ref(false);
const readmeLoading = ref(false);
/** Why the folder did not open, when it did not — naming the path so it can be opened by hand. */
const folderNotice = ref<string | null>(null);

const running = computed(() => run.value?.status === 'running');
const waitingForSelection = computed(() => awaitingSelection.value && run.value?.selection === null);
const canApply = computed(() => site.value !== null
  && kind.value !== null
  && source.value.trim().length > 0
  && !running.value);
const chosen = computed(() => offered.value.find((item) => item.key === kind.value) ?? null);
/** The run said there is more than one item to decide about. */
const askingToFilter = computed(() => reviewHtml.value !== null && run.value?.status === 'done');
const siteHasReadme = computed(() => (site.value?.adapters ?? []).some((item) => item.readme));

function explain(target: SiteprobeTarget): { single: boolean; acceptsName: boolean } {
  return { single: target.single, acceptsName: target.accepts_name };
}

/** Which of the four this site offers, in the order a person reads them. */
function offeredFor(found: SiteprobeSite): OfferedKind[] {
  return UI_KINDS.flatMap((uiKind) => {
    const declared = found.targets.filter((target) => uiKind.kinds.includes(target.kind)
      && explain(target).single === uiKind.single);
    if (declared.length === 0) return [];
    return [{
      key: uiKind.key,
      targets: declared.map((target) => target.kind),
      single: uiKind.single,
      acceptsName: declared.some((target) => explain(target).acceptsName),
      sources: [...new Set(declared.map((target) => target.source))],
      label: t(`siteprobe.kind.${uiKind.key}.label`),
      explanation: t(`siteprobe.kind.${uiKind.key}.why`),
    }];
  });
}

/** One file per key is the common case, and then the layer is not a question worth asking. */
const competingAdapters = computed(() => (site.value?.adapters.length ?? 0) > 1);

/** The layer in the person's own words, falling back to the tool's own name for a new one. */
function layerName(source: string): string {
  return t(`siteprobe.layer.${source}` as MessageKey) || source;
}

function resetRun(): void {
  run.value = null;
  log.value = [];
  error.value = null;
  inputProblem.value = null;
  reviewHtml.value = null;
  reviewCount.value = null;
  awaitingSelection.value = false;
  elapsed.value = 0;
  stopPolling();
}

/** The address decides the site, and — when it matches a rule — which kind it is. */
async function checkAddress(): Promise<void> {
  resetRun();
  resolvedKind.value = null;
  const text = address.value.trim();
  if (!text) {
    site.value = null;
    noRule.value = false;
    offered.value = [];
    kindsPreselected = false;
    return;
  }
  const known = siteForHost(sites.value, text);
  site.value = known;
  offered.value = known ? offeredFor(known) : [];
  kindsPreselected = false;
  noRule.value = known === null;
  if (!known || !props.api) return;
  try {
    const resolved = await props.api.siteprobeResolve({ input: text });
    if (resolved.matched) {
      site.value = sites.value.find((candidate) => candidate.key === resolved.site) ?? known;
      offered.value = site.value ? offeredFor(site.value) : [];
      resolvedKind.value = resolved.kind;
      const suggested = offered.value.find((item) => item.targets.includes(resolved.kind));
      if (suggested && kind.value === null) selectKind(suggested.key);
      // The address that decided the site is usually the answer the kind then asks for, so it is
      // carried over — a person pasting a work page should not have to paste it into a second field.
      if (!source.value.trim()) source.value = text;
    }
  } catch {
    // A miss is not a failure: the site is already known from the host, and the person picks a kind.
  }
}

let kindsPreselected = false;

function selectKind(next: UiKind): void {
  kind.value = next;
  inputProblem.value = null;
  const item = offered.value.find((candidate) => candidate.key === next);
  source.value = '';
  resolvedKind.value = null;
  if (item && !kindsPreselected && resolvedKind.value === null) kindsPreselected = true;
}

/** Validate the answer for the chosen kind *before* running, so a wrong address is not a bad crawl. */
async function validateSource(): Promise<string | null> {
  const chosenKind = chosen.value;
  if (!chosenKind || !site.value) return null;
  const text = source.value.trim();
  if (!text) return null;
  const resolved = await props.api.siteprobeResolve({ input: text, site: site.value.key });
  if (!resolved.matched) return resolved.detail;
  if (!chosenKind.targets.includes(resolved.kind)) {
    return t('siteprobe.inputWrongKind', { kind: chosenKind.label, tool: resolved.label });
  }
  resolvedKind.value = resolved.kind;
  return null;
}

async function apply(): Promise<void> {
  const chosenKind = chosen.value;
  if (!chosenKind || !site.value || running.value) return;
  error.value = null;
  inputProblem.value = null;
  const path = chosenKind.targets.includes(resolvedKind.value ?? '') ? resolvedKind.value : null;
  if (path === null) {
    try {
      inputProblem.value = await validateSource();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    if (inputProblem.value) return;
  }
  const toolKind = resolvedKind.value ?? chosenKind.targets[0];
  if (!toolKind) return;
  // Several items → scan for review first: that reads the listing's cards only, which is what makes
  // it affordable to ask "do you want to filter this?" *before* reading (and downloading) everything.
  await start({ input: source.value.trim(), site: site.value.key, kind: toolKind,
                review: !chosenKind.single });
}

async function start(request: Parameters<GalleryApi['startSiteprobeRun']>[0]): Promise<void> {
  resetRun();
  try {
    const started = await props.api.startSiteprobeRun(request);
    run.value = started;
    startPolling(started.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function startPolling(id: string, startedAt = Date.now()): void {
  stopPolling();
  elapsedTimer = setInterval(() => { elapsed.value = Math.round((Date.now() - startedAt) / 1000); }, 1000);
  const tick = async (): Promise<void> => {
    try {
      const job = await props.api.getSiteprobeRun(id);
      run.value = job;
      log.value = job.events.flatMap((event) => (event.event === 'progress' ? [event.message] : []));
      const review = job.events.find((event) => event.event === 'review');
      if (review && review.event === 'review') {
        reviewHtml.value = review.review_html;
        reviewCount.value = review.count ?? null;
      }
      if (job.status === 'running') {
        pollTimer = setTimeout(() => void tick(), awaitingSelection.value ? 2500 : 1000);
        return;
      }
      stopTimers();
      if (job.selection && awaitingSelection.value) {
        awaitingSelection.value = false;
        await start({ selection: job.selection });
        return;
      }
      await settle(job);
    } catch (cause) {
      stopTimers();
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  };
  pollTimer = setTimeout(() => void tick(), 600);
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  stopTimers();
}

function stopTimers(): void {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

/** A finished run: the export goes to the import review, a review page waits for the person. */
async function settle(job: NonNullable<typeof run.value>): Promise<void> {
  if (job.status === 'failed' || job.status === 'cancelled') {
    signingIn.value = false;
    loginDoneSent.value = false;
    error.value = job.error?.message ?? t('siteprobe.runFailed');
    errorLogPath.value = job.error?.logPath ?? null;
    return;
  }
  if (signingIn.value) {
    // The door closed: the session is written, and what the person was setting up is the run — the
    // specification's "when the bat finishes, come back to the import part". They can still Stop it.
    signingIn.value = false;
    const chosenKind = chosen.value;
    if (chosenKind && site.value) {
      await apply();
    }
    return;
  }
  if (job.result?.export) {
    await previewExport(job.result.export);
  }
}

async function previewExport(metadataPath: string): Promise<void> {
  busy.value = true;
  try {
    const preview = await props.api.previewSiteProbeExportPath(metadataPath);
    emit('preview', { preview, source: 'path' });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * Hand over the selection the browser downloaded.
 *
 * Some review pages save by downloading a file, and a download lands where the browser puts it —
 * measured on hitomi's own page, whose button is a plain `<a download>`, so T³'s watch (which looks
 * beside the review page) would wait for a file that already exists in the Downloads folder. The
 * file's text goes to the server, which writes it where the watch is looking; everything after that
 * is the flow that already existed.
 */
async function useDownloadedSelection(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const id = run.value?.id;
  if (!file || !id) return;
  error.value = null;
  selectionNotice.value = null;
  try {
    run.value = await props.api.uploadSiteprobeSelection(id, {
      name: file.name,
      content: await file.text(),
    });
    selectionNotice.value = t('siteprobe.selectionTaken', { name: file.name });
    awaitingSelection.value = true;
    startPolling(id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    input.value = '';
  }
}

/** Open the tool's own review page — over http, through this server, so no file paths are involved. */
function openReview(): void {
  if (!reviewHtml.value) return;
  const runId = run.value?.id;
  window.open(props.api.siteprobeExportFileUrl(reviewHtml.value, runId), '_blank', 'noopener');
  awaitingSelection.value = true;
  if (runId) startPolling(runId);
}

/** Skip the filter: read everything the listing holds. */
async function importEverything(): Promise<void> {
  const chosenKind = chosen.value;
  if (!chosenKind || !site.value) return;
  reviewHtml.value = null;
  await start({ input: source.value.trim(), site: site.value.key,
                kind: resolvedKind.value ?? chosenKind.targets[0] ?? 'work', review: false });
}

/** Everything a report would need, as text: what was asked for, what the tool said, where the log is. */
async function copyDiagnostics(): Promise<void> {
  const lines = [
    t('advanced.importReportTitle'),
    `site:    ${site.value?.key ?? ''}`,
    `kind:    ${kind.value ?? ''}`,
    `input:   ${source.value.trim()}`,
    `run:     ${run.value?.id ?? ''} (${run.value?.status ?? ''})`,
    `error:   ${run.value?.error?.code ?? ''} ${error.value ?? ''}`,
    `log:     ${errorLogPath.value ?? '(none)'}`,
  ];
  try {
    await copyText(lines.join(String.fromCharCode(10)));
    diagnosticsCopied.value = true;
  } catch {
    error.value = t('entry.copyDiagnostics');
  }
}

async function cancel(): Promise<void> {
  const id = run.value?.id;
  if (!id) return;
  try {
    run.value = await props.api.cancelSiteprobeRun(id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    stopPolling();
  }
}

/** The login door: the tool's own bat, in the console window T³ was started from. */
async function signIn(): Promise<void> {
  const target = address.value.trim();
  if (!target || running.value) return;
  signingIn.value = true;
  loginDoneSent.value = false;
  await start({ login: target });
}

/** "I have signed in": the one line the door is waiting for, sent from the page the person is on. */
async function reportSignedIn(): Promise<void> {
  const id = run.value?.id;
  if (!id) return;
  try {
    run.value = await props.api.siteprobeLoginDone(id);
    loginDoneSent.value = true;
    startPolling(id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function toggleReadme(): Promise<void> {
  if (!site.value) return;
  if (readmeOpen.value) {
    readmeOpen.value = false;
    return;
  }
  readmeOpen.value = true;
  if (readme.value?.site === site.value.key) return;
  readmeLoading.value = true;
  try {
    readme.value = await props.api.siteprobeReadme(site.value.key);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    readmeLoading.value = false;
  }
}

/**
 * Open the folder a hand-made or downloaded adapter goes into.
 *
 * T³ ships with no site-specific adapter of its own: the ones that need a sign-in are downloaded from
 * the project and dropped into this folder, and until now nothing in the UI said which folder that
 * is. A refusal is reported here with the path the server named, rather than as a bug report — the
 * useful next move is to open that path by hand.
 */
async function openAdaptorFolder(): Promise<void> {
  folderNotice.value = null;
  try {
    await props.api.revealSiteprobeFolder('installed');
  } catch (cause) {
    folderNotice.value = t('siteprobe.folderFailed',
      { detail: cause instanceof Error ? cause.message : String(cause) });
  }
}

/**
 * Take back a run this panel started before the person left.
 *
 * A run is a child process on the server, so switching tabs or leaving the page does not end it —
 * the panel used to forget it entirely, and a crawl of a few hundred works kept going with nothing
 * left to watch it, no progress and no cancel. Mounting asks the server what it still holds and
 * adopts the newest **running** run.
 *
 * Running only: a finished run has already written its export and left a review page, and adopting
 * one long afterwards would show a state the person has moved past. The orphan this exists for is
 * the live process.
 */
async function adoptRunningRun(): Promise<boolean> {
  let runs: Awaited<ReturnType<GalleryApi['listSiteprobeRuns']>>;
  try {
    runs = await props.api.listSiteprobeRuns();
  } catch {
    // A server that cannot list its runs leaves the panel starting from the beginning, as before.
    return false;
  }
  const running = runs
    .filter((job) => job.command === 'run' && job.status === 'running')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  if (!running) return false;
  // The site and the kind the run is *for*, back in the chooser it was started from. This is not
  // decoration: the stop control lives inside the chosen kind's block, so a run adopted without its
  // kind would be visible and unstoppable — the same complaint one layer down.
  const known = running.site === null
    ? null
    : sites.value.find((candidate) => candidate.key === running.site) ?? null;
  site.value = known;
  offered.value = known ? offeredFor(known) : [];
  noRule.value = known === null;
  kind.value = offered.value.find((item) => running.kind !== null
    && item.targets.includes(running.kind))?.key ?? null;
  address.value = running.input;
  error.value = null;
  run.value = running;
  log.value = running.events.flatMap((event) => (event.event === 'progress' ? [event.message] : []));
  startPolling(running.id, Date.parse(running.startedAt));
  return true;
}

const lastProgress = computed(() => log.value.at(-1) ?? null);

onMounted(async () => {
  try {
    const event = await props.api.siteprobeSites();
    sites.value = event.sites;
  } catch (cause) {
    unavailable.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
  await adoptRunningRun();
});

onBeforeUnmount(stopPolling);
</script>

<template>
  <div data-testid="siteprobe-panel" class="advanced-import">
    <p v-if="unavailable" data-testid="siteprobe-unavailable" class="muted">
      {{ t('siteprobe.unavailable', { detail: unavailable }) }}
    </p>

    <template v-else>
      <label class="field-label" for="add-entry-advanced-url">{{ t('siteprobe.address') }}</label>
      <input
        id="add-entry-advanced-url"
        v-model="address"
        data-testid="siteprobe-address"
        class="secondary-input"
        type="url"
        :placeholder="t('siteprobe.addressPlaceholder')"
        @change="checkAddress"
      >
      <p class="muted">{{ t('siteprobe.addressHint') }}</p>

      <p v-if="noRule" data-testid="siteprobe-no-match" class="muted">
        {{ t('siteprobe.noRule') }}
      </p>
      <div v-if="noRule" class="advanced-import__actions">
        <button
          data-testid="siteprobe-build-rule"
          class="secondary-button"
          type="button"
          @click="emit('build-rule', address.trim())"
        >
          {{ t('siteprobe.buildRule') }}
        </button>
        <!-- The other way to get a rule for a site: a downloaded adapter, dropped into the folder
             this opens. The folder is the server's to choose, so the browser only names the layer. -->
        <button
          data-testid="siteprobe-open-folder"
          class="text-button"
          type="button"
          :title="t('siteprobe.folderHint')"
          @click="openAdaptorFolder"
        >
          {{ t('siteprobe.adaptorFolder') }}
        </button>
      </div>
      <p v-if="folderNotice" data-testid="siteprobe-folder-problem" class="advanced-import__problem">
        {{ folderNotice }}
      </p>

      <template v-if="site && offered.length > 0">
        <p data-testid="siteprobe-rule-found" class="advanced-import__found">
          {{ t('siteprobe.ruleFound', { target: site.hosts[0] ?? site.key }) }}
          <button
            v-if="siteHasReadme"
            data-testid="siteprobe-readme-toggle"
            class="text-button"
            type="button"
            :aria-expanded="readmeOpen"
            @click="toggleReadme"
          >
            {{ t('siteprobe.adaptorExisting') }} ?
          </button>
          <button
            data-testid="siteprobe-open-folder-found"
            class="text-button"
            type="button"
            :title="t('siteprobe.folderHint')"
            @click="openAdaptorFolder"
          >
            {{ t('siteprobe.adaptorFolder') }}
          </button>
        </p>
        <div v-if="readmeOpen" data-testid="siteprobe-readme" class="advanced-import__readme">
          <p v-if="readmeLoading" class="muted">{{ t('siteprobe.readmeLoading') }}</p>
          <pre v-else>{{ readme?.text || t('siteprobe.readmeNone') }}</pre>
        </div>

        <!-- One row per kind, never a dropdown: each kind covers a different part of a site, and a
             person choosing has to be able to read what each one means. -->
        <div class="advanced-import__kinds" role="radiogroup" :aria-label="t('siteprobe.kinds')">
          <button
            v-for="item in offered"
            :key="item.key"
            :data-testid="`siteprobe-kind-${item.key}`"
            class="advanced-import__kind"
            :class="{ 'advanced-import__kind--on': kind === item.key }"
            type="button"
            role="radio"
            :aria-checked="kind === item.key"
            @click="selectKind(item.key)"
          >
            <span class="advanced-import__kind-head">
              <strong class="t3-library-text">{{ item.label }}</strong>
              <span
                v-if="competingAdapters"
                :data-testid="`siteprobe-kind-source-${item.key}`"
                class="muted advanced-import__kind-layer"
              >{{ item.sources.map(layerName).join(' · ') }}</span>
            </span>
            <span class="muted">{{ item.explanation }}</span>
          </button>
        </div>

        <template v-if="chosen">
          <label class="field-label" for="add-entry-advanced-source">
            {{ chosen.acceptsName ? t('siteprobe.sourceName') : t('siteprobe.sourceAddress') }}
          </label>
          <input
            id="add-entry-advanced-source"
            v-model="source"
            data-testid="siteprobe-source"
            class="secondary-input"
            type="text"
            :placeholder="chosen.acceptsName ? 'kakao' : 'https://…'"
          >
          <p v-if="chosen.key === 'playlist'" class="advanced-import__login-question">
            <label>
              <input v-model="playlistNeedsLogin" data-testid="siteprobe-playlist-login"
                type="checkbox">
              {{ t('siteprobe.playlistLogin') }}
            </label>
          </p>
          <p v-if="chosen.key === 'playlist' && playlistNeedsLogin" class="muted">
            {{ t('siteprobe.playlistLoginHint') }}
          </p>

          <p v-if="inputProblem" data-testid="siteprobe-input-problem" class="advanced-import__problem">
            {{ inputProblem }}
          </p>

          <div class="advanced-import__actions">
            <button
              data-testid="siteprobe-run"
              class="primary-button"
              type="button"
              :disabled="!canApply"
              @click="apply"
            >
              {{ t('siteprobe.apply') }}
            </button>
            <button
              v-if="chosen.key === 'playlist' && playlistNeedsLogin"
              data-testid="siteprobe-login"
              class="secondary-button"
              type="button"
              :disabled="running"
              @click="signIn"
            >
              {{ t('siteprobe.signIn') }}
            </button>
            <button
              v-if="running"
              data-testid="siteprobe-cancel"
              class="secondary-button"
              type="button"
              @click="cancel"
            >
              {{ t('siteprobe.stop') }}
            </button>
          </div>
        </template>
      </template>

      <!-- While it works: what the tool last said, and how long it has been saying it. -->
      <div v-if="running || lastProgress" data-testid="siteprobe-status" class="advanced-import__status">
        <p>{{ t('siteprobe.working') }}<span v-if="running"> · {{ elapsed }}s</span></p>
        <p v-if="lastProgress" class="muted">{{ lastProgress }}</p>
        <!-- The sign-in is finished in the browser, and answered here: a console window the person
             has to find is not an interaction (their words, after the first real sign-in). -->
        <div v-if="signingIn && running" class="advanced-import__actions">
          <button data-testid="siteprobe-login-done" class="primary-button" type="button"
            :disabled="loginDoneSent" @click="reportSignedIn">
            {{ t('siteprobe.loginDone') }}
          </button>
          <span class="muted">{{ t('siteprobe.loginDoneHint') }}</span>
        </div>
      </div>

      <div v-if="askingToFilter" data-testid="siteprobe-ask-filter" class="advanced-import__ask">
        <p>
          {{ reviewCount === null
            ? t('siteprobe.severalItems')
            : t('siteprobe.severalItemsCount', { count: reviewCount }) }}
        </p>
        <p class="muted">{{ t('siteprobe.filterOffer') }}</p>
        <div class="advanced-import__actions">
          <button data-testid="siteprobe-filter" class="primary-button" type="button" @click="openReview">
            {{ t('siteprobe.filterYes') }}
          </button>
          <button data-testid="siteprobe-import-all" class="secondary-button" type="button"
            @click="importEverything">
            {{ t('siteprobe.filterNo') }}
          </button>
        </div>
      </div>

      <div v-if="waitingForSelection" data-testid="siteprobe-waiting" class="advanced-import__waiting">
        <p class="muted">{{ t('siteprobe.waitingSelection') }}</p>
        <!-- The page saves its selection by downloading a file, so the file is what comes back here:
             no paths, and it works for a review page that never learned to write anywhere else. -->
        <label class="field-label" for="add-entry-selection-file">{{ t('siteprobe.selectionFile') }}</label>
        <input id="add-entry-selection-file" data-testid="siteprobe-selection-file" type="file"
          accept="application/json,.json" class="secondary-input" @change="useDownloadedSelection">
      </div>

      <!-- Outside the waiting block on purpose: taking the file is what ends the wait, so a notice
           inside it would disappear in the same render that produced it. -->
      <p v-if="selectionNotice" data-testid="siteprobe-selection-taken" class="muted">
        {{ selectionNotice }}
      </p>

      <div v-if="failure" data-testid="siteprobe-error" class="advanced-import__problem">
        <p>{{ failure.message }}</p>
        <!-- The stage that read nothing, before the "report this" ask: a person who sees "the listing
             produced no card" does not need to file a bug (plan §5-E). -->
        <p v-if="failure.kind === 'input'" class="muted">{{ t('siteprobe.inputHint') }}</p>
        <template v-else-if="failure.kind === 'bug'">
          <p class="muted">{{ t('siteprobe.bugHint') }}</p>
          <p v-if="errorLogPath" class="muted">{{ t('siteprobe.bugLog', { path: errorLogPath }) }}</p>
          <button data-testid="siteprobe-copy-diagnostics" class="secondary-button" type="button"
            @click="copyDiagnostics">
            {{ t('entry.copyDiagnostics') }}
          </button>
          <p v-if="diagnosticsCopied" data-testid="siteprobe-diagnostics-copied" class="muted">
            {{ t('entry.diagnosticsCopied') }}
          </p>
        </template>
        <p v-else class="muted">{{ t('siteprobe.runFailedAgain') }}</p>
      </div>

      <ul v-if="runFindings.length > 0" data-testid="siteprobe-findings" class="muted">
        <li v-for="finding in runFindings" :key="finding.code + finding.stage">
          [{{ finding.stage }}] {{ finding.message }}
          <span v-if="finding.advice">— {{ finding.advice }}</span>
        </li>
      </ul>

      <details v-if="log.length > 0" class="advanced-import__log">
        <summary>{{ t('siteprobe.log') }}</summary>
        <pre data-testid="siteprobe-log">{{ log.join('\n') }}</pre>
      </details>
    </template>
  </div>
</template>

<style scoped>
.advanced-import { display: flex; flex-direction: column; gap: 0.6rem; }
.advanced-import__found { margin: 0; font-weight: 600; }
.advanced-import__kinds { display: flex; flex-direction: column; gap: 0.4rem; }
.advanced-import__kind {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.advanced-import__kind--on { border-color: var(--accent); background: var(--surface-raised); }
.advanced-import__kind-head { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
/* Which layer answers this kind. A chip rather than a sentence: it is there to be read at a glance,
   and only when two files for one site make the answer a question. */
.advanced-import__kind-layer {
  padding: 0 0.35rem;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 400;
}
.advanced-import__actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.advanced-import__problem { color: var(--text-warning, #c9822a); margin: 0; }
.advanced-import__status { display: flex; flex-direction: column; gap: 0.2rem; }
.advanced-import__ask {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
}
.advanced-import__waiting { display: flex; flex-direction: column; gap: 0.4rem; }
.advanced-import__readme pre { white-space: pre-wrap; overflow-x: auto; }
.advanced-import__log pre { white-space: pre-wrap; max-height: 14rem; overflow-y: auto; }
</style>
