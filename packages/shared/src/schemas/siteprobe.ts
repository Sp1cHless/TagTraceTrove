import { z } from 'zod';

/**
 * The machine contract of the local SiteProbe tool (`<siteprobe>/integration.py`), validated at
 * this boundary on purpose: the server is the one place that both talks to the tool and answers a
 * browser, so a line the tool prints that is not part of the contract is caught here, once, instead
 * of surfacing as undefined fields in the web app.
 *
 * `event` names and `code` values are the Python side's own vocabulary — see
 * `siteprobe/src/generic/integration.py` (`ERROR_CODES`). Keep the two lists in step: the tool is
 * not a dependency this repo type-checks.
 */

export const siteprobeErrorCodeSchema = z.enum([
  // The caller asked for something the tool cannot answer; the answer is a question back.
  'NO_MATCH',
  'INVALID_INPUT',
  'AMBIGUOUS',
  'UNKNOWN_SITE',
  // The work failed.
  'NO_MODULE',
  'NO_REVIEW',
  'NOTHING_LISTED',
  'RUN_FAILED',
  'INTERNAL',
]);

/**
 * Where a fault was seen — the tool's own stage vocabulary (`siteprobe/src/generic/diagnostics.py`,
 * `STAGES`). Keep the two lists in step, the same way the error codes above are.
 */
export const siteprobeFindingStageSchema = z.enum([
  'target',
  'acquisition',
  'listing',
  'work',
  'media',
  'import',
]);

/**
 * One structured reason a run produced nothing (plan §4.1). Carried on the events that already
 * exist rather than as a new event, so a caller that ignores it reads exactly the event it read
 * before. `code` is the contract and is not reworded; `message` is a sentence and may be.
 */
export const siteprobeFindingSchema = z.strictObject({
  code: z.string().trim().min(1),
  stage: siteprobeFindingStageSchema,
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  field: z.string().optional(),
  target_kind: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  suggested_action: z.string().optional(),
});


/** One target kind a site declares: what the UI offers as "object type". */
export const siteprobeTargetSchema = z.strictObject({
  kind: z.string().trim().min(1),
  label: z.string(),
  /** One work rather than a listing — a review step makes no sense for it. */
  single: z.boolean(),
  /** The input may be a bare name instead of a URL. */
  accepts_name: z.boolean(),
  /** Which adapter layer declares it (`installed`, `local`, …). */
  source: z.string().trim().min(1),
});

const siteprobeAdapterSchema = z.strictObject({
  source: z.string().trim().min(1),
  reads: z.array(z.string()),
  /**
   * Whether the adapter folder carries a `README.md` — the site's own words about what it covers,
   * which sites need a sign-in and what is special about them. The text itself is fetched only when
   * somebody opens it (`GET /api/siteprobe/readme`), so a menu does not carry every readme.
   */
  readme: z.boolean(),
});

export const siteprobeSiteSchema = z.strictObject({
  key: z.string().trim().min(1),
  display_name: z.string(),
  export_group: z.string(),
  hosts: z.array(z.string()),
  targets: z.array(siteprobeTargetSchema),
  /**
   * Every adapter file that carries this key. One key can carry two — a written adapter and a rule
   * set learned for one of its listings — and `targets` above is the union of both.
   */
  adapters: z.array(siteprobeAdapterSchema),
});

export const siteprobeSitesEventSchema = z.strictObject({
  event: z.literal('sites'),
  home: z.string(),
  sites: z.array(siteprobeSiteSchema),
});

const resolveMatchedSchema = z.strictObject({
  event: z.literal('resolve'),
  matched: z.literal(true),
  input: z.string(),
  site: z.string().trim().min(1),
  display_name: z.string(),
  export_group: z.string(),
  source: z.string(),
  kind: z.string().trim().min(1),
  label: z.string(),
  single: z.boolean(),
  ref: z.record(z.string(), z.string()),
});

const resolveMissedSchema = z.strictObject({
  event: z.literal('resolve'),
  matched: z.literal(false),
  input: z.string(),
  reason: siteprobeErrorCodeSchema,
  detail: z.string(),
});

/** A miss is an answer, not an error: it is what the clipboard flow asks for. */
export const siteprobeResolveEventSchema = z.union([resolveMatchedSchema, resolveMissedSchema]);

const siteprobeProgressEventSchema = z.strictObject({
  event: z.literal('progress'),
  message: z.string(),
});

const siteprobeReviewEventSchema = z.strictObject({
  event: z.literal('review'),
  site: z.string(),
  kind: z.string(),
  ref: z.string(),
  listing: z.string(),
  review_html: z.string(),
  summary: z.record(z.string(), z.unknown()),
  /**
   * How many items the page holds, under one name the tool reports for every site (its own summary
   * keeps the site's own vocabulary beside it). Optional on purpose: an older tool that does not
   * send it still produces a usable review, and the caller then says "several" instead of a number.
   */
  count: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()),
  /** Why a stage produced nothing, when it did (plan §4.1). Optional: an older tool omits it. */
  findings: z.array(siteprobeFindingSchema).optional(),
});

/** One site's own description of itself, as markdown — empty when the folder has none. */
export const siteprobeReadmeEventSchema = z.strictObject({
  event: z.literal('readme'),
  site: z.string(),
  source: z.string().nullable(),
  text: z.string(),
});

/**
 * The tool's own origin document, passed through as it is. The authoritative conversion into the
 * batch's `origin` happens in `loadSiteProbeExport`, so this stays permissive rather than pinning a
 * shape the importer is about to rewrite.
 */
const siteprobeOriginSchema = z.record(z.string(), z.unknown());

export const siteprobeResultEventSchema = z.strictObject({
  event: z.literal('result'),
  command: z.enum(['run', 'selection']),
  site: z.string(),
  kind: z.string(),
  ref: z.string(),
  /** How many works the export holds; null for a review run, whose page is the product. */
  works: z.number().int().nonnegative().nullable(),
  listing: z.string(),
  /** The `metadata.json` this server hands to `loadSiteProbeExport`; null before a selection. */
  export: z.string().nullable(),
  review_html: z.string().nullable(),
  origin: siteprobeOriginSchema.nullable(),
  media: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
  /** Structured reasons this run produced nothing, empty when it is clean (plan §4.1). */
  findings: z.array(siteprobeFindingSchema).optional(),
  /** Only on a selection run: the file it downloaded. */
  selection: z.string().optional(),
});

export const siteprobeErrorEventSchema = z.strictObject({
  event: z.literal('error'),
  code: siteprobeErrorCodeSchema,
  message: z.string(),
  command: z.string().optional(),
  selection: z.string().optional(),
  /**
   * The reasons a `DiagnosticError` failed the run. The `code` above stays inside its enum for
   * callers already branching on it; the specific stage travels here (plan §4.1).
   */
  findings: z.array(siteprobeFindingSchema).optional(),
});

/**
 * One bounded runtime check, reported per stage (plan §5-A) — the `integration probe` command's
 * answer. A stage that was `skipped` or `unavailable` is not a pass, and `ok` is false whenever any
 * finding is error-severity.
 */
export const siteprobeProbeEventSchema = z.strictObject({
  event: z.literal('probe'),
  target: z.string(),
  /** The probed address, with query values redacted. */
  input: z.string(),
  ok: z.boolean(),
  budget: z.strictObject({ seconds: z.number(), used: z.number() }),
  /** The standard export the probe wrote, for T³'s own parser to read — never the live export tree. */
  export: z.string().nullable(),
  stages: z.array(z.strictObject({
    stage: siteprobeFindingStageSchema,
    status: z.enum(['passed', 'failed', 'skipped', 'unavailable']),
    detail: z.string(),
    findings: z.array(siteprobeFindingSchema),
  })),
  findings: z.array(siteprobeFindingSchema),
});

export const siteprobeEventSchema = z.union([
  siteprobeProgressEventSchema,
  siteprobeReviewEventSchema,
  siteprobeResultEventSchema,
  siteprobeErrorEventSchema,
]);

/**
 * Every line the tool may print on stdout, including the two answers that are not a run
 * (`sites`, `resolve`). This is what the transport validates each line against: the boundary is one
 * place, and it knows the whole contract rather than the half a run produces.
 */
export const siteprobeLineSchema = z.union([
  siteprobeSitesEventSchema,
  siteprobeResolveEventSchema,
  siteprobeReadmeEventSchema,
  siteprobeProgressEventSchema,
  siteprobeReviewEventSchema,
  siteprobeResultEventSchema,
  siteprobeErrorEventSchema,
  siteprobeProbeEventSchema,
]);

export const siteprobeRunStatusSchema = z.enum(['running', 'done', 'failed', 'cancelled']);

/**
 * What a run job may be. `login` is a different program (the tool's own bat, in a console window)
 * with a different stdout contract (none — the conversation happens in that window), but it is the
 * same *shape* of job: something the person started, that takes as long as it takes, that they can
 * watch and cancel.
 */
export const siteprobeRunCommandSchema = z.enum(['run', 'selection', 'login', 'build']);

export const siteprobeRunSchema = z.strictObject({
  id: z.string(),
  command: siteprobeRunCommandSchema,
  input: z.string(),
  site: z.string().nullable(),
  kind: z.string().nullable(),
  review: z.boolean(),
  status: siteprobeRunStatusSchema,
  /** Bounded: a scan of hundreds of works emits a line per work, and the tail is what is read. */
  events: z.array(siteprobeEventSchema),
  eventsDropped: z.number().int().nonnegative(),
  result: siteprobeResultEventSchema.nullable(),
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    /**
     * The error log this server wrote for an internal fault, when it wrote one. Present only for the
     * faults a person is meant to report — the ones the tool or this server did not anticipate — so
     * "copy the diagnostics" has something to name.
     */
    logPath: z.string().optional(),
  }).nullable(),
  /**
   * Set once a review run's listing has a `selection_*.json` beside its page — what the "save" in
   * the review page produces. The caller then starts a selection run with it.
   */
  selection: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const siteprobeStatusSchema = z.strictObject({
  ok: z.boolean(),
  home: z.string(),
  tool: z.string(),
  python: z.string(),
  detail: z.string().nullable(),
});

/** Either a crawl input or a selection file — one route, because both are "run the tool once". */
export const siteprobeRunRequestSchema = z.union([
  z.strictObject({
    input: z.string().trim().min(1),
    site: z.string().trim().min(1).optional(),
    kind: z.string().trim().min(1).optional(),
    review: z.boolean().default(false),
    limit: z.number().int().positive().optional(),
    refresh: z.boolean().default(false),
  }),
  z.strictObject({
    selection: z.string().trim().min(1),
  }),
  /** Sign a site in once: a URL on the site, or its key. Runs the tool's own login door. */
  z.strictObject({
    login: z.string().trim().min(1),
  }),
  /**
   * Build an adapter for a site from its pages. The tool opens an annotation page per page it reads
   * and waits for the person to submit it, so this run's clock is human; its stdout is guidance, not
   * a contract.
   *
   * Two builds share this shape, and `kind` is what tells them apart:
   *
   * * **a work adapter** — one to three work URLs, no `kind`;
   * * **a listing adapter** — the listing's first page and its second page (the second one is how the
   *   adapter learns to turn the page), with `kind` naming the listing (`search`, `artist`, …).
   */
  z.strictObject({
    build: z.array(z.string().trim().url()).min(1).max(3),
    /**
     * Which listing this build is for. Present means a **listing** build — the tool then learns a
     * listing rule of that kind instead of a work's fields — and a listing needs exactly two
     * addresses: its first page and its second.
     */
    kind: z.string().trim().min(1).optional(),
    /**
     * The language T³'s interface is in, so the annotation pages the tool opens for this build
     * read like the screen the person came from. The tool has no idea what that is — it is a
     * Python process on the other side of a pipe — so it travels with the request.
     */
    lang: z.enum(['zh', 'en']).optional(),
  }).refine((value) => value.kind === undefined || value.build.length === 2, {
    message: 'a listing build takes the listing’s first page and its second page',
    path: ['build'],
  }),
]);

export const siteprobeExportPreviewRequestSchema = z.strictObject({
  metadataPath: z.string().trim().min(1),
});

/**
 * A site's readme, asked for when somebody opens it.
 *
 * Always 200 with the site named: a site whose folder has no readme answers with empty text rather
 * than an error, because "no description" is an answer to the question that was asked.
 */
export const siteprobeReadmeSchema = z.strictObject({
  site: z.string(),
  source: z.string().nullable(),
  text: z.string(),
});

/**
 * "Show me the folder adapters go in", said as a key and never as a path.
 *
 * The three source layers a person can put a file into, named the way the tool's own architecture
 * names them. A route that accepted a path from the browser would turn this local server into a way
 * to open anything on the machine, so the path is chosen server-side from the tool's home and the
 * caller only picks which layer.
 */
export const siteprobeRevealFolderRequestSchema = z.strictObject({
  folder: z.enum(['installed', 'local', 'home']),
});

/** Where the folder turned out to be. The path goes back so the UI can show it if opening fails. */
export const siteprobeRevealFolderSchema = z.strictObject({
  folder: z.enum(['installed', 'local', 'home']),
  path: z.string(),
});

/**
 * A selection the browser downloaded, handed back so the watch can see it.
 *
 * A review page saves its selection by downloading a file, and where a download lands is the
 * browser's business — measured on hitomi's own page, which uses a plain `<a download>` and so writes
 * into the Downloads folder, never beside the page. T³ watches the listing directory, so for that
 * page the watch would wait an hour for a file that already exists somewhere else. This carries the
 * file's bytes across that gap; the server writes them where the watch is looking.
 */
export const siteprobeSelectionUploadSchema = z.strictObject({
  /** The name the browser downloaded it as; only its base name is used. */
  name: z.string().trim().min(1),
  /** The file's text, which must parse as a JSON object. */
  content: z.string().min(2).max(1_000_000),
});

/** A path inside the export tree, served to the browser — the review page, and its selection. */
export const siteprobeExportFileRequestSchema = z.strictObject({
  path: z.string().trim().min(1),
});

/**
 * One pasted link, read with no site rule: the quick-create form's "try" button.
 *
 * `verdict` is what the person needs to know, and it is deliberately coarse:
 * * `found` — a title and a cover were read, and the form fills them in;
 * * `needs-advanced` — the page needs a rule, a session, or another attempt (the tool's own
 *   `insufficient` / `teaching` / `retryable` / `blocked`), so the answer is "use Advanced import",
 *   never a bug report;
 * * `invalid` — not an http(s) URL;
 * * `bug` — this server or the tool failed unexpectedly, and `logPath` names the evidence.
 */
export const siteprobeLinkVerdictSchema = z.enum(['found', 'needs-advanced', 'invalid', 'bug']);

export const siteprobeLinkMetaSchema = z.strictObject({
  verdict: siteprobeLinkVerdictSchema,
  /** The reader's own token (`ok`, `no-title`, `blocked`, …): kept for the log and for support. */
  outcome: z.string().nullable(),
  detail: z.string().nullable(),
  title: z.string().nullable(),
  /**
   * The cover itself, as a data URL. Level 0 reads and keeps nothing: the bytes travel with the
   * answer, the page turns them into a `File`, and creating the Entry stores them where every other
   * cover is stored — so no export folder exists at any point.
   */
  coverDataUrl: z.string().nullable(),
  coverMimeType: z.string().nullable(),
  coverBytes: z.number().int().nonnegative().nullable(),
  /** The error log written for a `bug` verdict. */
  logPath: z.string().nullable(),
});

export const siteprobeLinkRequestSchema = z.strictObject({
  url: z.string().trim().min(1),
});

/** "Who claims this input?" — asked before anything is downloaded, and by the clipboard flow. */
export const siteprobeResolveRequestSchema = z.strictObject({
  input: z.string().trim().min(1),
  site: z.string().trim().min(1).optional(),
  kind: z.string().trim().min(1).optional(),
});

export type SiteprobeTarget = z.infer<typeof siteprobeTargetSchema>;
export type SiteprobeSite = z.infer<typeof siteprobeSiteSchema>;
export type SiteprobeSitesEvent = z.infer<typeof siteprobeSitesEventSchema>;
export type SiteprobeResolveEvent = z.infer<typeof siteprobeResolveEventSchema>;
export type SiteprobeResultEvent = z.infer<typeof siteprobeResultEventSchema>;
export type SiteprobeEvent = z.infer<typeof siteprobeEventSchema>;
export type SiteprobeLine = z.infer<typeof siteprobeLineSchema>;
export type SiteprobeRunStatus = z.infer<typeof siteprobeRunStatusSchema>;
export type SiteprobeRunCommand = z.infer<typeof siteprobeRunCommandSchema>;
export type SiteprobeReadmeEvent = z.infer<typeof siteprobeReadmeEventSchema>;
export type SiteprobeReadme = z.infer<typeof siteprobeReadmeSchema>;
export type SiteprobeSelectionUpload = z.infer<typeof siteprobeSelectionUploadSchema>;
export type SiteprobeRun = z.infer<typeof siteprobeRunSchema>;
/**
 * What a caller sends. The schema's own defaults (`review`, `refresh`) are filled in by the server,
 * so the request type is the schema's *input*: a caller must not have to spell out a default it does
 * not have an opinion about.
 */
export type SiteprobeRunRequest = z.input<typeof siteprobeRunRequestSchema>;
export type SiteprobeResolveRequest = z.infer<typeof siteprobeResolveRequestSchema>;
export type SiteprobeLinkVerdict = z.infer<typeof siteprobeLinkVerdictSchema>;
export type SiteprobeLinkMeta = z.infer<typeof siteprobeLinkMetaSchema>;
export type SiteprobeStatus = z.infer<typeof siteprobeStatusSchema>;
export type SiteprobeRevealFolder = z.infer<typeof siteprobeRevealFolderRequestSchema>['folder'];
export type SiteprobeRevealFolderResult = z.infer<typeof siteprobeRevealFolderSchema>;
export type SiteprobeErrorCode = z.infer<typeof siteprobeErrorCodeSchema>;
export type SiteprobeFindingStage = z.infer<typeof siteprobeFindingStageSchema>;
export type SiteprobeFinding = z.infer<typeof siteprobeFindingSchema>;
export type SiteprobeProbeEvent = z.infer<typeof siteprobeProbeEventSchema>;
