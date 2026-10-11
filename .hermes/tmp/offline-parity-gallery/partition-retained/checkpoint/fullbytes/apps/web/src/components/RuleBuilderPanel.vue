<script setup lang="ts">
/**
 * The rule-building page: a guided sequence, one state at a time.
 *
 * The specification is explicit about the shape: this page teaches more than it asks, so each state
 * shows one screen of guidance and nothing else, the states advance in order, and every state
 * carries 重新开始 in its corner. What it drives is the tool's adapter builder — a job whose clock
 * is the person annotating pages in the browser, and whose lines are guidance, exactly like the
 * login door.
 *
 * The builder's own annotation pages open in the browser (the tool opens them); this page is the
 * status surface: what is happening, what to do next, and where a fault's evidence goes. When the
 * builder finishes, the natural next step is seeing the result: the first work is imported through
 * the ordinary run, and its export goes to the import review.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import type { GalleryApi } from '../api/gallery.js';
import type { ImportPreview, SiteprobeSite } from '@t3/shared';
import { useI18n } from '../i18n.js';
import { siteProbeAdapterStatus, type SiteProbeAdapterStatus } from '../siteprobe/adapter-status.js';

const props = defineProps<{ api: GalleryApi; draftUrl?: string | undefined }>();
const emit = defineEmits<{
  /** The first work's export is ready for the import review. */
  preview: [payload: { preview: ImportPreview; source: 'path' }];
}>();

const { t, locale } = useI18n();

type Phase = 'intro' | 'prepare' | 'urls' | 'building' | 'ready';
const phase = ref<Phase>('intro');

/**
 * Which generator this run is: the site's **work** adapter, or a **listing** adapter on top of it.
 *
 * The specification's second phase puts the listing half inside the same page, below the work half, and
 * the two share this page's states — a listing is entered from 状态2 (or from the work state's "this
 * site already has an adapter" notice) and runs its own version of 状态3.
 */
const flow = ref<'work' | 'listing'>('work');

const firstUrl = ref('');
const secondUrl = ref('');
const thirdUrl = ref('');

/** The listing half: which listing, and the two pages that teach it (the second teaches pagination). */
const LISTING_KINDS = ['search', 'artist', 'favorites', 'album', 'playlist'] as const;
/** How many works the listing preview imports — enough to see the shape, not a crawl. */
const LISTING_PREVIEW_LIMIT = 10;
const listingKind = ref('');
const listingFirst = ref('');
const listingSecond = ref('');
const listingExisting = ref<SiteProbeAdapterStatus | null>(null);

/**
 * What the tool's registry says about the address in the first field.
 *
 * Asked once per address, automatically, on the field's own `change` — the person pastes a work URL
 * and the page tells them whether this site already has an adapter, because a build for a site that
 * has one *replaces* that adapter (the learned file for a host is one file). Nothing is blocked: it
 * is a warning, and the build is the person's decision.
 */
const sites = ref<SiteprobeSite[]>([]);
const existing = ref<SiteProbeAdapterStatus | null>(null);

const build = ref<Awaited<ReturnType<GalleryApi['getSiteprobeRun']>> | null>(null);
const buildLines = ref<string[]>([]);
const buildError = ref<string | null>(null);
const buildBug = ref(false);
const elapsed = ref(0);
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

/** The follow-up run that imports the first work once the adapter is installed. */
const importing = ref(false);
const importLines = ref<string[]>([]);

const building = computed(() => phase.value === 'building' && build.value?.status === 'running');
/** The tool has said an annotation page is open: the person's move is in the browser. */
const pageOpen = computed(() => buildLines.value.some((line) => line.includes('opening the page (annotate)')));
/** `=== installed` is the builder's own "the adapter is on disk" line. */
const installed = computed(() => buildLines.value.some((line) => line.startsWith('=== installed')));
const addresses = computed(() => [firstUrl.value, secondUrl.value, thirdUrl.value]
  .map((url) => url.trim()).filter((url) => url.length > 0));
const canBuild = computed(() => addresses.value.length > 0 && !building.value);

/**
 * A listing build is the listing's **first page and its second** — the second is what teaches the
 * adapter to turn the page, so the confirm waits for both (the request schema refuses any other count,
 * which is the same rule said where it cannot be bypassed).
 */
const listingAddresses = computed(() => [listingFirst.value, listingSecond.value]
  .map((url) => url.trim()).filter((url) => url.length > 0));
const canBuildListing = computed(() => listingKind.value !== ''
  && listingAddresses.value.length === 2 && !building.value);

/** What went wrong, said the way the specification lists it. */
const failure = computed(() => {
  if (!buildError.value) return null;
  if (buildBug.value) return { kind: 'bug' as const, message: buildError.value };
  // The builder refused: the site is beyond the generic reader (its exit and message are the
  // evidence), which is the specification's "过于复杂" verdict, not a bug.
  return { kind: 'complex' as const, message: buildError.value };
});

/**
 * Take back a build this page started before the person left.
 *
 * A build is a child process on the server whose clock is a person annotating in the browser, so
 * leaving the page — switching tabs, going to another work — does not end it. The panel used to
 * forget it completely: the process kept running with no log, no state and no 重新开始 to stop it,
 * and the only way out was to find the browser window or restart T³. Mounting asks the server what
 * it is still holding and adopts the newest **running** build.
 *
 * Running only, on purpose: a finished build has already written whatever it wrote (the adapter, or
 * the refusal), and adopting one hours later would show a state the person has long moved past. The
 * orphan this exists for is the live process, not the record of a finished one.
 */
async function adoptRunningBuild(): Promise<boolean> {
  let runs: Awaited<ReturnType<GalleryApi['listSiteprobeRuns']>>;
  try {
    runs = await props.api.listSiteprobeRuns();
  } catch {
    // A server that cannot list its runs is not an error of this page's: the panel simply starts
    // from the beginning, which is what it did before this existed.
    return false;
  }
  const running = runs
    .filter((run) => run.command === 'build' && run.status === 'running')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  if (!running) return false;
  // `kind` is what makes a build a *listing* build, so the page comes back in the half it was
  // started from — the same fact the request carried.
  flow.value = running.kind === null ? 'work' : 'listing';
  // The addresses the running build is for, back in the fields it was started from. They are what
  // the page is *about*, and leaving them blank would show a build for nothing; `input` is the
  // request's own addresses joined by a space, and an address has no space in it.
  const addresses = running.input.split(' ').map((url) => url.trim()).filter(Boolean);
  if (flow.value === 'listing') {
    listingKind.value = running.kind ?? '';
    listingFirst.value = addresses[0] ?? '';
    listingSecond.value = addresses[1] ?? '';
    checkListingAddress();
  } else {
    firstUrl.value = addresses[0] ?? '';
    secondUrl.value = addresses[1] ?? '';
    thirdUrl.value = addresses[2] ?? '';
    checkFirstAddress();
  }
  build.value = running;
  buildLines.value = running.events.flatMap((event) => (
    event.event === 'progress' ? [event.message] : []));
  buildError.value = null;
  buildBug.value = false;
  phase.value = 'building';
  startPolling(running.id, Date.parse(running.startedAt));
  return true;
}

function startFromIntro(): void {
  phase.value = 'prepare';
}

/**
 * The site a build would write for, and whether it already has an adapter.
 *
 * The address is what names the site (its host), never a domain the person has to remember or
 * choose. A failure to read the registry is not an error of its own: the page can build anyway, and
 * the warning is the only thing lost.
 */
function checkFirstAddress(event?: Event): void {
  const typed = (event?.target as HTMLInputElement | null)?.value;
  const text = (typed ?? firstUrl.value).trim();
  existing.value = text ? siteProbeAdapterStatus(sites.value, text) : null;
}

/**
 * The same check for the listing half's first page, and it answers a different question: a listing
 * adapter is built *on top of* a work adapter — the crawl reads each card's work page with the work
 * rules — so a site that has none is told to build that first, with a door to it.
 */
function checkListingAddress(event?: Event): void {
  const typed = (event?.target as HTMLInputElement | null)?.value;
  const text = (typed ?? listingFirst.value).trim();
  listingExisting.value = text ? siteProbeAdapterStatus(sites.value, text) : null;
}

onMounted(async () => {
  try {
    sites.value = (await props.api.siteprobeSites()).sites;
    checkFirstAddress();
  } catch {
    // A registry that cannot be read leaves the warning off; the build itself still reports.
  }
  // Asked after the registry, so a build that is adopted below can still say whether the site has an
  // adapter — the notice beside the address and the adopted build's own log are read together.
  await adoptRunningBuild();
});

function startFromPrepare(): void {
  // The advanced page's handover arrives as a prop: an address with no rule is usually the very
  // page to learn from, so it is already in the first field.
  if (props.draftUrl && !firstUrl.value) {
    firstUrl.value = props.draftUrl;
    checkFirstAddress();
  }
  flow.value = 'work';
  phase.value = 'urls';
}

/** 准备好了，开始列表适配器: the listing half of the same page. */
function startListing(): void {
  flow.value = 'listing';
  phase.value = 'urls';
  listingKind.value = '';
  listingFirst.value = '';
  listingSecond.value = '';
  listingExisting.value = null;
  build.value = null;
  buildLines.value = [];
  buildError.value = null;
  buildBug.value = false;
  importLines.value = [];
}

/**
 * 添加列表适配器 from the work state's "this site already has an adapter" notice — or the door the
 * listing state offers when the site has no work adapter at all: the same state, the other way round.
 */
function switchToWorkAdapter(): void {
  flow.value = 'work';
  phase.value = 'urls';
  if (listingFirst.value && !firstUrl.value) {
    firstUrl.value = listingFirst.value.trim();
    checkFirstAddress();
  }
}

/** 重新开始: stop whatever is running and return to the first state. */
async function restart(): Promise<void> {
  const id = build.value?.id;
  if (id && build.value?.status === 'running') {
    try {
      await props.api.cancelSiteprobeRun(id);
    } catch {
      // The page is going back to the start either way; a dead job's window is closed by the tool.
    }
  }
  stopTimers();
  build.value = null;
  buildLines.value = [];
  buildError.value = null;
  buildBug.value = false;
  importing.value = false;
  importLines.value = [];
  firstUrl.value = '';
  secondUrl.value = '';
  thirdUrl.value = '';
  existing.value = null;
  flow.value = 'work';
  listingKind.value = '';
  listingFirst.value = '';
  listingSecond.value = '';
  listingExisting.value = null;
  phase.value = 'intro';
}

async function openAdapter(): Promise<void> {
  buildError.value = null;
  buildBug.value = false;
  phase.value = 'building';
  try {
    // The annotation pages the tool opens are part of this flow, so they are served in the language
    // this page is read in — the tool cannot know it, and the person reading them is right here.
    const started = await props.api.startSiteprobeRun({
      build: addresses.value,
      // The tool's pages are part of this flow, so they are served in the language this page is
      // read in. T³'s locales are `en` and `zh-CN`; the tool's table has `zh` and `en`.
      lang: locale.value === 'en' ? 'en' : 'zh',
    });
    build.value = started;
    startPolling(started.id);
  } catch (cause) {
    buildBug.value = true;
    buildError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * 链接填好了，点击打开列表适配器.
 *
 * The same door as the work build, with two differences the request itself carries: both pages of the
 * listing, and the `kind` that says which listing this is — the flag the tool's own bat passes, and the
 * one that selects `build_listing.py` on the other side.
 */
async function openListingAdapter(): Promise<void> {
  buildError.value = null;
  buildBug.value = false;
  phase.value = 'building';
  try {
    const started = await props.api.startSiteprobeRun({
      build: listingAddresses.value,
      kind: listingKind.value,
      lang: locale.value === 'en' ? 'en' : 'zh',
    });
    build.value = started;
    startPolling(started.id);
  } catch (cause) {
    buildBug.value = true;
    buildError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function startPolling(id: string, startedAt = Date.now()): void {
  stopTimers();
  elapsedTimer = setInterval(() => {
    elapsed.value = Math.round((Date.now() - startedAt) / 1000);
  }, 1000);
  const tick = async (): Promise<void> => {
    try {
      const job = await props.api.getSiteprobeRun(id);
      build.value = job;
      buildLines.value = job.events.flatMap((event) => (event.event === 'progress' ? [event.message] : []));
      if (job.status === 'running') {
        pollTimer = setTimeout(() => void tick(), 1500);
        return;
      }
      stopTimers();
      settleBuild(job);
    } catch (cause) {
      stopTimers();
      buildBug.value = true;
      buildError.value = cause instanceof Error ? cause.message : String(cause);
    }
  };
  pollTimer = setTimeout(() => void tick(), 800);
}

function settleBuild(job: NonNullable<typeof build.value>): void {
  if (job.status === 'failed' || job.status === 'cancelled') {
    // A traceback means a crash; anything else is the builder refusing a site it cannot read.
    buildBug.value = job.error?.code === 'INTERNAL';
    buildError.value = job.error?.message ?? t('siteprobe.runFailed');
    return;
  }
  if (installed.value) {
    phase.value = 'ready';
  } else {
    // Exited 0 without installing, or exited 1: the round trip did not agree. The builder's own
    // lines above say which field; the verdict here is the specification's.
    buildError.value = t('rule.tooComplex');
  }
}

/** 适配器生成完毕 → import the first work through the ordinary run. */
async function importFirstWork(): Promise<void> {
  const first = addresses.value[0];
  if (first) await runAndPreview({ input: first });
}

/**
 * The listing's own preview: the **first ten works** of the address the person gave, not the whole
 * listing.
 *
 * A listing can hold thousands of works — a search result, an author's page — and the point here is to
 * see that the adapter reads the shape, so the run is capped where the fetching is bounded, not after
 * it. The review that follows is the same one a work import lands on, so ten works are reviewed exactly
 * as one is.
 */
async function importListingPreview(): Promise<void> {
  const first = listingFirst.value.trim();
  if (first) await runAndPreview({ input: first, kind: listingKind.value, limit: LISTING_PREVIEW_LIMIT });
}

/** Run once and hand its export to the import review — the one door both previews use. */
async function runAndPreview(request: Parameters<GalleryApi['startSiteprobeRun']>[0]): Promise<void> {
  if (importing.value) return;
  importing.value = true;
  try {
    const started = await props.api.startSiteprobeRun(request);
    const id = started.id;
    for (;;) {
      // A run that downloads media is never instant; poll to the end.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const job = await props.api.getSiteprobeRun(id);
      importLines.value = job.events.flatMap((event) => (event.event === 'progress' ? [event.message] : []));
      if (job.status === 'running') continue;
      if (job.status !== 'done' || !job.result?.export) {
        buildError.value = job.error?.message ?? t('siteprobe.runFailed');
        buildBug.value = job.error?.code === 'INTERNAL';
        return;
      }
      const preview = await props.api.previewSiteProbeExportPath(job.result.export);
      emit('preview', { preview, source: 'path' });
      return;
    }
  } catch (cause) {
    buildBug.value = true;
    buildError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    importing.value = false;
  }
}

async function copyDiagnostics(): Promise<void> {
  const lines = [
    t('advanced.builderReportTitle'),
    `urls:  ${addresses.value.join(' ; ')}`,
    `run:   ${build.value?.id ?? ''} (${build.value?.status ?? ''})`,
    `error: ${build.value?.error?.code ?? ''} ${buildError.value ?? ''}`,
    ...buildLines.value.slice(-12).map((line) => `  ${line}`),
  ];
  try {
    await navigator.clipboard.writeText(lines.join(String.fromCharCode(10)));
  } catch {
    // The clipboard can refuse; the lines stay on screen to copy by hand.
  }
}

function stopTimers(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

onBeforeUnmount(stopTimers);
</script>

<template>
  <div data-testid="rule-builder" class="rule-builder">
    <!-- 重新开始: the shared rounded control, in a row of its own. It used to be absolutely placed
         in the corner, which put it on top of whatever the state had there — measured on the
         address state, where it sat across the first field's label and its input. In 状态2 it shares
         the row with that state's own title (单作品生成器), which is what the specification asks for. -->
    <div v-if="phase !== 'prepare'" class="rule-builder__top">
      <button data-testid="rule-restart" class="secondary-button rule-builder__restart" type="button"
        @click="restart">
        {{ t('rule.restart') }}
      </button>
    </div>

    <!-- 初始状态: what this tool is for, and what it cannot do. -->
    <template v-if="phase === 'intro'">
      <div data-testid="rule-intro" class="rule-builder__guidance">
        <p>{{ t('rule.intro.what') }}</p>
        <p>{{ t('rule.intro.order') }}</p>
        <p class="rule-builder__limits">{{ t('rule.intro.limitStrong') }}</p>
        <p class="rule-builder__limits">{{ t('rule.intro.limitLogin') }}</p>
        <p class="rule-builder__limits">{{ t('rule.intro.limitAntibot') }}</p>
        <p class="muted">{{ t('rule.intro.patience') }}</p>
      </div>
      <button data-testid="rule-begin" class="primary-button" type="button" @click="startFromIntro">
        {{ t('rule.begin') }}
      </button>
    </template>

    <!-- 状态 2: pick the pages to teach with — the work half, and the listing half below it. -->
    <template v-else-if="phase === 'prepare'">
      <div class="rule-builder__heading">
        <h3 data-testid="rule-work-title">{{ t('rule.workTitle') }}</h3>
        <button data-testid="rule-restart" class="secondary-button rule-builder__restart" type="button"
          @click="restart">
          {{ t('rule.restart') }}
        </button>
      </div>
      <div data-testid="rule-prepare" class="rule-builder__guidance">
        <p>{{ t('rule.prepare.urls') }}</p>
        <p class="muted">{{ t('rule.prepare.pick') }}</p>
      </div>
      <button data-testid="rule-prepare-done" class="primary-button" type="button"
        @click="startFromPrepare">
        {{ t('rule.prepareDone') }}
      </button>

      <!-- 第二阶段: the listing adapter, entered from here (or from the work state's notice). -->
      <div data-testid="rule-listing-intro" class="rule-builder__section">
        <h3>{{ t('rule.listing.title') }}</h3>
        <p>{{ t('rule.listing.lead') }}</p>
        <p class="muted">{{ t('rule.listing.leadOrder') }}</p>
        <button data-testid="rule-listing-start" class="primary-button" type="button"
          @click="startListing">
          {{ t('rule.listing.start') }}
        </button>
      </div>
    </template>

    <!-- 状态 3, the work half: the three addresses, the tips, and the builder's live status. -->
    <template v-else-if="flow === 'work'">
      <div class="rule-builder__guidance">
        <label class="field-label" for="rule-url-1">{{ t('rule.urlFirst') }}</label>
        <input id="rule-url-1" v-model="firstUrl" data-testid="rule-url-1" class="secondary-input"
          type="url" :placeholder="'https://…'" :disabled="phase !== 'urls'"
          @input="checkFirstAddress" @change="checkFirstAddress">
        <!-- The address is checked once it is entered, and said before anything is built. -->
        <div v-if="existing?.exists" class="rule-builder__exists-row">
          <p data-testid="rule-adapter-exists" class="rule-builder__exists">
            {{ t('rule.adapterExists') }}
          </p>
          <!-- The other half of the same page, one click away: a site that already has a work adapter
               is exactly the site a listing adapter can be built on. -->
          <button data-testid="rule-add-listing" class="secondary-button rule-builder__restart"
            type="button" @click="startListing">
            {{ t('rule.addListing') }}
          </button>
        </div>
        <label class="field-label" for="rule-url-2">{{ t('rule.urlMore') }}</label>
        <input id="rule-url-2" v-model="secondUrl" data-testid="rule-url-2" class="secondary-input"
          type="url" :placeholder="'https://…'" :disabled="phase !== 'urls'">
        <label class="field-label" for="rule-url-3">{{ t('rule.urlMore') }}</label>
        <input id="rule-url-3" v-model="thirdUrl" data-testid="rule-url-3" class="secondary-input"
          type="url" :placeholder="'https://…'" :disabled="phase !== 'urls'">
      </div>

      <button v-if="phase === 'urls'" data-testid="rule-open-adapter" class="primary-button"
        type="button" :disabled="!canBuild" @click="openAdapter">
        {{ t('rule.openAdapter') }}
      </button>

      <div data-testid="rule-tips" class="rule-builder__guidance">
        <p class="rule-builder__tips-title">{{ t('rule.tipsTitle') }}</p>
        <ol class="rule-builder__tips">
          <li>{{ t('rule.tipCopy') }}</li>
          <li>{{ t('rule.tipMatch') }}</li>
          <li>{{ t('rule.tipCombine') }}</li>
        </ol>
      </div>

      <!-- 适配器生成完毕. -->
      <div v-if="phase === 'ready'" data-testid="rule-ready" class="rule-builder__ready">
        <p>{{ t('rule.built') }}</p>
        <p class="muted">{{ t('rule.builtPreview') }}</p>
        <button data-testid="rule-import-first" class="primary-button" type="button"
          :disabled="importing" @click="importFirstWork">
          {{ t('rule.importFirst') }}
        </button>
        <p v-if="importing" class="muted">{{ t('rule.importing') }}</p>
        <p v-if="importLines.length > 0" class="muted">{{ importLines.at(-1) }}</p>
      </div>
    </template>

    <!-- 状态 3, the listing half: which listing, its two pages, and the card page it opens. -->
    <template v-else>
      <div class="rule-builder__guidance" data-testid="rule-listing-kinds">
        <p class="field-label">{{ t('rule.listing.kindLabel') }}</p>
        <div class="rule-builder__kinds">
          <button v-for="kind in LISTING_KINDS" :key="kind" type="button" class="secondary-button"
            :class="{ 'rule-builder__kind-active': listingKind === kind }"
            :data-listing-kind="kind" @click="listingKind = kind">
            {{ t(`rule.listing.kind.${kind}`) }}
          </button>
        </div>
        <p class="muted">{{ t('rule.listing.kindHint') }}</p>
      </div>

      <div v-if="listingKind !== ''" class="rule-builder__guidance">
        <label class="field-label" for="rule-listing-url-1">{{ t('rule.listing.urlFirst') }}</label>
        <input id="rule-listing-url-1" v-model="listingFirst" data-testid="rule-listing-url-1"
          class="secondary-input" type="url" :placeholder="'https://…'" :disabled="phase !== 'urls'"
          @input="checkListingAddress" @change="checkListingAddress">
        <!-- A listing adapter is built on top of a work adapter: the crawl reads each card's work page
             with the work rules, so a site without one is told to build that first. -->
        <template v-if="listingExisting && !listingExisting.exists">
          <p data-testid="rule-listing-no-work-adapter" class="rule-builder__exists">
            {{ t('rule.listing.noWorkAdapter') }}
          </p>
          <button data-testid="rule-listing-go-work" class="secondary-button" type="button"
            @click="switchToWorkAdapter">
            {{ t('rule.listing.goWorkAdapter') }}
          </button>
        </template>
        <label class="field-label" for="rule-listing-url-2">{{ t('rule.listing.urlSecond') }}</label>
        <input id="rule-listing-url-2" v-model="listingSecond" data-testid="rule-listing-url-2"
          class="secondary-input" type="url" :placeholder="'https://…'" :disabled="phase !== 'urls'">
        <p class="muted">{{ t('rule.listing.urlSecondHint') }}</p>
      </div>

      <button v-if="phase === 'urls' && listingKind !== ''" data-testid="rule-listing-open"
        class="primary-button" type="button" :disabled="!canBuildListing" @click="openListingAdapter">
        {{ t('rule.listing.open') }}
      </button>

      <div v-if="listingKind !== ''" data-testid="rule-listing-tips" class="rule-builder__guidance">
        <p class="rule-builder__tips-title">{{ t('rule.listing.tipsTitle') }}</p>
        <ol class="rule-builder__tips">
          <li>{{ t('rule.listing.tipReference') }}</li>
          <li>{{ t('rule.listing.tipLogin') }}</li>
          <li>{{ t('rule.listing.tipLess') }}</li>
          <li>{{ t('rule.listing.tipRight') }}</li>
        </ol>
      </div>

      <!-- 适配器生成完毕 → the first ten works of the listing, through the ordinary import review. -->
      <div v-if="phase === 'ready'" data-testid="rule-listing-ready" class="rule-builder__ready">
        <p>{{ t('rule.built') }}</p>
        <p class="muted">{{ t('rule.listing.builtPreview', { count: String(LISTING_PREVIEW_LIMIT) }) }}</p>
        <button data-testid="rule-import-listing" class="primary-button" type="button"
          :disabled="importing" @click="importListingPreview">
          {{ t('rule.listing.importPreview', { count: String(LISTING_PREVIEW_LIMIT) }) }}
        </button>
        <p class="muted">{{ t('rule.listing.importHint') }}</p>
        <p v-if="importing" class="muted">
          {{ t('rule.listing.importing', { count: String(LISTING_PREVIEW_LIMIT) }) }}
        </p>
        <p v-if="importLines.length > 0" class="muted">{{ importLines.at(-1) }}</p>
      </div>
    </template>

    <!-- The builder's own status, standing in for the console the person never sees. Both flows
         share it: what it reports is the tool's stdout either way. -->
    <div v-if="(phase === 'building' || phase === 'ready' || build) && phase !== 'intro' && phase !== 'prepare'"
      data-testid="rule-status" class="rule-builder__status">
      <p v-if="building && !pageOpen" data-testid="rule-status-preparing" class="muted">
        {{ t('rule.preparing') }}<span class="rule-builder__dots" aria-hidden="true" />
        <span v-if="elapsed > 0"> · {{ elapsed }}s</span>
      </p>
      <p v-if="pageOpen && building" data-testid="rule-status-page-open" class="rule-builder__page-open">
        {{ t('rule.pageOpen') }}
      </p>
      <details v-if="buildLines.length > 0" class="rule-builder__log">
        <summary>{{ t('rule.log') }}</summary>
        <pre>{{ buildLines.join(String.fromCharCode(10)) }}</pre>
      </details>
    </div>

    <!-- The verdicts. -->
    <div v-if="failure" data-testid="rule-error" class="rule-builder__problem">
      <p>{{ failure.message }}</p>
      <p v-if="failure.kind === 'complex'" class="muted">{{ t('rule.tooComplexHint') }}</p>
      <template v-else>
        <p class="muted">{{ t('rule.bugHint') }}</p>
        <button data-testid="rule-copy-diagnostics" class="secondary-button" type="button"
          @click="copyDiagnostics">
          {{ t('entry.copyDiagnostics') }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.rule-builder { display: flex; flex-direction: column; gap: 0.7rem; }
/* The corner action keeps its own row, so no state has to know to leave room for it. */
.rule-builder__top { display: flex; justify-content: flex-end; }
/* 状态2's title and 重新开始 on one line, and a section the person reads before the next one. */
.rule-builder__heading { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.rule-builder__heading h3 { margin: 0; font-size: 1rem; }
.rule-builder__section { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem;
  padding-top: 1rem; border-top: 1px solid var(--border-subtle, #d8d8d8); }
.rule-builder__section h3 { margin: 0; font-size: 1rem; }
.rule-builder__section p { margin: 0; max-width: 46rem; }
/* The warning and the door it suggests belong on one line. */
.rule-builder__exists-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
.rule-builder__kinds { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.rule-builder__kind-active { border-color: var(--accent); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent); }
/* `text-button` is a page-local class in AuthorPage, so with that name this button fell back to the
   browser's own chrome — square, bordered, and bigger than anything else on the page. It is the
   shared control like every other action, sized like the entry editor's corner actions. */
.rule-builder__restart { padding: 0.3rem 0.7rem; font-size: 0.78rem; }
.rule-builder__guidance { display: flex; flex-direction: column; gap: 0.5rem; }
.rule-builder__guidance p { margin: 0; max-width: 46rem; }
.rule-builder__limits { color: var(--text-secondary, #8a6d3b); }
.rule-builder__tips { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 0.3rem; }
.rule-builder__tips-title { font-weight: 600; }
.rule-builder__exists { color: var(--text-warning, #c9822a); font-weight: 600; }
.rule-builder__status { display: flex; flex-direction: column; gap: 0.3rem; }
.rule-builder__page-open { color: var(--accent); font-weight: 600; }
.rule-builder__problem { display: flex; flex-direction: column; gap: 0.4rem; color: var(--text-warning, #c9822a); }
.rule-builder__problem p { margin: 0; }
.rule-builder__ready { display: flex; flex-direction: column; gap: 0.4rem; }
.rule-builder__ready p { margin: 0; }
.rule-builder__dots::after { content: ''; animation: rule-dots 1.5s steps(4) infinite; }
@keyframes rule-dots {
  0% { content: ''; }
  25% { content: '.'; }
  50% { content: '..'; }
  75% { content: '...'; }
}
.rule-builder__log pre { white-space: pre-wrap; max-height: 12rem; overflow-y: auto; }
</style>
