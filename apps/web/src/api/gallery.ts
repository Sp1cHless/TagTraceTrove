import {
  assignProducerTagRequestSchema,
  assignEntryTagRequestSchema,
  authorDetailResponseSchema,
  authorDirectorySchema,
  authorFilterOptionsResponseSchema,
  createAuthorDirectoryRequestSchema,
  createEntryContentRequestSchema,
  createEntryRequestSchema,
  createAuthorRatingSlotRequestSchema,
  createProducerRequestSchema,
  createFacetRequestSchema,
  createRatingSlotRequestSchema,
  createSectionRequestSchema,
  createSectionResponseSchema,
  entryDetailResponseSchema,
  entryContentRecordSchema,
  entrySourceRecordSchema,
  entryPageQueryRequestSchema,
  entryPageResponseSchema,
  entryRecordSchema,
  entryTagAssignmentSchema,
  entryTagUsageSchema,
  facetFilterOptionsResponseSchema,
  collectionRecordSchema,
  addCollectionTagRequestSchema,
  addCollectionTagResponseSchema,
  createCollectionRequestSchema,
  createTemporaryCollectionRequestSchema,
  temporaryCollectionResponseSchema,
  galleryPartitionRequestSchema,
  galleryCardLayoutRequestSchema,
  galleryCardLayoutsResponseSchema,
  type GalleryCardLayout,
  syncGalleryPartitionContextSchema,
  syncEntryRatingLayoutContextSchema,
  syncEntryRatingLayoutSettlementSchema,
  galleryOrderResponseSchema,
  gallerySummarySchema,
  setGalleryOrderRequestSchema,
  importCommitRequestSchema,
  importCommitResultSchema,
  importPreviewSchema,
  siteprobeLinkMetaSchema,
  siteprobeLinkRequestSchema,
  siteprobeResolveEventSchema,
  siteprobeResolveRequestSchema,
  siteprobeRunRequestSchema,
  siteprobeRunSchema,
  siteprobeReadmeSchema,
  siteprobeRevealFolderRequestSchema,
  siteprobeRevealFolderSchema,
  siteprobeSelectionUploadSchema,
  siteprobeSitesEventSchema,
  siteprobeStatusSchema,
  importTaxonomyAliasesRequestSchema,
  renameTagGroupRequestSchema,
  layoutResponseSchema,
  layoutTemplateApplyResponseSchema,
  mergeViewLaterRequestSchema,
  applyTitleShorteningRequestSchema,
  applyTitleShorteningResponseSchema,
  titleShorteningPlanResponseSchema,
  mergeAuthorEntriesRequestSchema,
  mergeAuthorEntriesResponseSchema,
  convertEntryAuthorsResponseSchema,
  moveEntryTagRequestSchema,
  producerRecordSchema,
  producerMergePlanResponseSchema,
  producerMergeResponseSchema,
  producerPageQueryRequestSchema,
  producerPageResponseSchema,
  producerSummarySchema,
  producerTagAssignmentSchema,

  renameEntryTagRequestSchema,
  renameProducerTagRequestSchema,
  reorderEntryContentsRequestSchema,
  reorderSectionFacetsRequestSchema,
  relationSuggestionResponseSchema,
  producerSuggestionQuerySchema,
  tagSuggestionQuerySchema,
  commitSourceMaintenanceRequestSchema,
  commitSourceMaintenanceResponseSchema,
  createSourceMaintenanceRunRequestSchema,
  sourceMaintenanceItemPageQuerySchema,
  sourceMaintenanceItemPageResponseSchema,
  sourceMaintenanceItemPatchSchema,
  sourceLibraryRecordSchema,
  sourceStatusPatchSchema,
  sourceStatusRecordSchema,
  navigationCountsSchema,
  syncCapabilitiesSchema,
  syncChangesQuerySchema,
  syncChangesResponseSchema,
  syncMediaUploadMetadataSchema,
  syncMediaUploadResultSchema,
  syncReplayRequestSchema,
  syncReplayResultSchema,
  syncSnapshotSchema,
  ratingRowSchema,
  ratingSlotSchema,
  numberIdListSchema,
  reorderCollectionsRequestSchema,
  reorderRatingSlotsRequestSchema,
  setRatingRequestSchema,
  setProducerGalleryAnchorRequestSchema,
  setEntryMediaOrderRequestSchema,
  updateCollectionRequestSchema,
  tagLayoutApplyResponseSchema,
  tagSearchHitSchema,
  tagDeleteRequestSchema,
  tagMergeRequestSchema,
  applyCommonTemplateRequestSchema,
  applyCommonTemplateResponseSchema,
  commonTemplateSchema,
  contentKindsResponseSchema,
  templateSummarySchema,
  taxonomyAliasSchema,
  usageInfoSchema,
  upsertTaxonomyAliasRequestSchema,
  authorAliasGroupsResponseSchema,
  saveAuthorAliasGroupRequestSchema,
  saveAuthorAliasGroupResponseSchema,
  updateEntryContentRequestSchema,
  updateEntryRequestSchema,
  updateAuthorDirectoryRequestSchema,
  updateProducerRequestSchema,
  viewLaterStateSchema,
  type AuthorDetailResponse,
  type AuthorDirectoryDto,
  type AuthorFilterOptions,
  type CreateAuthorDirectoryRequest,
  type AssignEntryTagRequest,
  type EntryTagAssignment,
  type CreateEntryContentRequest,
  type CreateEntryRequest,
  type CreateFacetRequest,
  type CreateSectionRequest,
  type EntryDetailResponse,
  type EntryPageQueryRequest,
  type EntryPageResponse,
  type EntryRecordDto,
  type EntrySourceRecordDto,
  type SourceLibraryRecordDto,
  type SourceMaintenanceItemPageQuery,
  type SourceMaintenanceItemRecordDto,
  type SourceMaintenanceRunRecordDto,
  type CommitSourceMaintenanceResponse,
  type SourceStatusPatch,
  type SourceStatusRecordDto,
  type NavigationCounts,
  type SyncCapabilities,
  syncEntryIdentitySchema,
  syncCollectionIdentitySchema,
  type SyncEntryIdentity,
  type SyncChangesQuery,
  type SyncMediaUploadMetadata,
  type SyncMediaUploadResult,
  type SyncReplayRequest,
  type SyncReplayResult,
  type SyncSnapshot,
  type EntryTagUsage,
  type FacetFilterOptions,
  type GallerySummary,
  type ImportBatch,

  type UsageInfo,
  type ImportCommitMapping,
  type ImportCommitResult,
  type ImportPreview,
  type SiteprobeLinkMeta,
  type SiteprobeResolveEvent,
  type SiteprobeResolveRequest,
  type SiteprobeRun,
  type SiteprobeRunRequest,
  type SiteprobeReadme,
  type SiteprobeRevealFolder,
  type SiteprobeRevealFolderResult,
  type SiteprobeSelectionUpload,
  type SiteprobeSitesEvent,
  type SiteprobeStatus,
  type ConvertEntryAuthorsResponse,
  type ApplyTitleShorteningResponse,
  type TitleShorteningChange,
  type TitleShorteningPlanResponse,
  type MergeAuthorEntriesRequest,
  type MergeAuthorEntriesResponse,
  type ImportTaxonomyAliasesRequest,
  type CreateProducerRequest,
  type TemporaryCollectionResponse,
  type ProducerRecordDto,
  type ProducerMergePlanResponse,
  type ProducerMergeResponse,
  type ProducerPageQueryRequest,
  type ProducerPageResponse,
  type ProducerSuggestionQueryInput,
  type RelationSuggestionDto,
  type TagSuggestionQueryInput,

  type AuthorAliasGroup,
  type SaveAuthorAliasGroupRequest,
  type SaveAuthorAliasGroupResponse,
  type CollectionKind,
  type CollectionRecordDto,
  type ApplyCommonTemplateResponse,
  type CommonTemplate,
  type TemplateSummary,
  type RatingRow,
  type RatingSlotDto,
  type LayoutTemplateApplyResponse,
  type TagLayoutApplyResponse,
  type TagSearchHit,
  type TaxonomyAliasDto,
  siteDictionaryImportResultSchema,
  taxonomyAliasImportResultSchema,
  type TaxonomyAliasImportResult,
  type SiteDictionaryImportResult,
  type TaxonomyVocabulary,
  type UpsertTaxonomyAliasRequest,
  type UpdateAuthorDirectoryRequest,
  type UpdateProducerRequest,
  type UpdateEntryContentRequest,
  type UpdateEntryRequest,
  type ViewLaterState,
} from '@t3/shared';
import { syncDeltaRequestSchema, syncDeltaPageSchema, syncAckRequestSchema, syncAckResponseSchema, type SyncDeltaRequest, type SyncDeltaPage, type SyncAckRequest } from '@t3/shared';
import { ApiError, createApiClient, type ApiClient } from './client.js';
import { normalizeTrustedLanHttpOrigin } from './trusted-lan-origin.mjs';

// A stable per-browser sync client identity for receipts written by requests
// this tab originated; the offline facade keeps its own store-backed identity.
let browserClientId: string | null = null;
function stableBrowserClientId(): string {
  if (browserClientId !== null) return browserClientId;
  const storage = globalThis.localStorage;
  const existing = storage?.getItem('t3.online-client-id') ?? null;
  const value = existing ?? (globalThis.crypto?.randomUUID?.()
    ?? `online-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (existing === null) storage?.setItem('t3.online-client-id', value);
  browserClientId = value;
  return value;
}

export interface GalleryEntrySummary {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRef: string | null;
  previewRefs: string[];
  uploadDate: string | null;
  pageCount: number | null;
  durationSeconds?: number | null | undefined;
  /** What the card shows in place of an image; absent in a list read before this existed. */
  coverText?: string | null | undefined;
  viewCount: number;
  likeCount: number;
  lastViewedAt: string | null;
}

export interface GalleryAuthorSummary {
  id: number;
  name: string;
  covers: string[];
  galleryType: string | null;
  viewCount: number;
  likeCount: number;
  lastViewedAt: string | null;
  nsfw: boolean;
}


export interface OfflineEntryCreateRequest {
  durationSeconds?: number | null;
  title: string;
  type: string;
  uploadDate: string | null;
  pageCount: number | null;
  ratings: Array<{ slotId: number; stars: number }>;
  viewLater: boolean;
  coverFile: File | null;
  previewFile: File | null;
  /** Full ordered Preview selection. Older callers can keep using previewFile. */
  previewFiles?: File[];
  /** Preserve the identity of a preceding online POST if its response was lost. */
  syncUid?: string;
  /** Initial Content only; never mutate an already queued create operation. */
  contents?: Array<{ contentType: string; content: string }>;
  /**
   * The exact create command an uncertain online submit already attempted.
   * Offline replay must reuse its identity (opId, clientCreatedAt, Content
   * UIDs) so the server receipt resolves the ambiguity instead of colliding.
   */
  presetCreateOperation?: SyncReplayRequest;
}

export interface PendingOfflineEntryTagValue { name: string; facetId: number }
export interface PendingOfflineEntryTagOptions {
  canCreateTag?: boolean;
  canCreateFacet?: boolean;
  sections?: Array<{ id: number; name: string }>;
  facets: Array<{ id: number; name: string }>;
  tags: PendingOfflineEntryTagValue[];
  availableTags: Array<{ id: number; name: string }>;
}
export interface PendingOfflineEntryAuthorValue { producerUid: string; name: string }
export interface PendingOfflineEntryAuthorOptions { authors: PendingOfflineEntryAuthorValue[]; canCreateAuthor?: boolean }
export interface PendingOfflineEntryContentValue { syncUid: string; contentType: string; content: string; sortOrder: number }
export interface PendingOfflineEntryCreate {
  canEditContents?: boolean;
  contentEditStatus?: 'pending' | 'conflict' | 'failed';
  contentEditError?: string | null;
  canEditMetadata?: boolean;
  metadataEditStatus?: 'pending' | 'conflict' | 'failed';
  metadataEditError?: string | null;
  authors?: PendingOfflineEntryAuthorValue[];
  authorStatus?: 'pending' | 'conflict' | 'failed';
  authorLastError?: string | null;
  canEditAuthors?: boolean;
  canEditTags?: boolean;
  tags?: PendingOfflineEntryTagValue[];
  tagEditStatus?: 'pending' | 'conflict' | 'failed';
  tagEditError?: string | null;
  localKey: `local:${string}`;
  durationSeconds?: number | null;
  title: string;
  type: string;
  uploadDate: string | null;
  pageCount: number | null;
  status: 'pending' | 'conflict' | 'failed';
  lastError?: string | null;
  /** Persisted operation-specific capability and writable parent state, not just API method presence. */
  canAppendContent?: boolean;
  contents?: Array<{ syncUid?: string; sortOrder?: number; contentType: string; content: string;
    status?: 'pending' | 'conflict' | 'failed'; lastError?: string | null }>;
}

/** Every way an Entry's images can be unavailable for deletion or reordering. */
export type EntryMediaRemovalBlockReason =
  | 'no-server-row'
  | 'upload-uncertain'
  | 'cover-not-uploaded'
  | 'native-uncertain';

export interface GalleryApi {
  resumeNativeTransfers?(): Promise<{active:number;completed:number;held:number;remainingOperations:number;standaloneMedia?:number;foregroundMedia?:number;dependencyHeld?:number;capabilityHeld?:number;foregroundReason?:string}>;
  previewPendingWorkRestore?(text: string): Promise<import('../offline/pending-work-restore.js').PendingWorkRestorePreview>;
  restorePendingWork?(text: string): Promise<import('../offline/pending-work-restore.js').PendingWorkRestorePreview>;
  getPendingOfflineEntryContentOptions?(localKey: string): Promise<{ contents: PendingOfflineEntryContentValue[] }>;
  enqueueOfflinePendingEntryContents?(localKey: string, desired: PendingOfflineEntryContentValue[]): Promise<void>;
  enqueueOfflinePendingEntryMetadata?(localKey: string, values: { title: string; uploadDate: string | null; pageCount: number | null; durationSeconds?: number | null }): Promise<void>;
  assetUrl(path: string): string;
  getViewLaterState(): Promise<ViewLaterState>;
  addViewLaterEntry(entryId: number): Promise<ViewLaterState>;
  removeViewLaterEntry(entryId: number): Promise<ViewLaterState>;
  mergeViewLaterEntries(entryIds: number[]): Promise<ViewLaterState>;
  addViewLaterAuthor(authorId: number): Promise<ViewLaterState>;
  removeViewLaterAuthor(authorId: number): Promise<ViewLaterState>;
  listGalleries(): Promise<GallerySummary[]>;
  /**
   * Store the order the sidebar lists Galleries in.
   *
   * The whole list, always: the exchange control sends every Gallery after a move, so what a person
   * sees is what is stored — a swap of two rows would leave the rest in the alphabet.
   */
  setGalleryOrder(types: string[]): Promise<string[]>;
  queryEntryPage(input: EntryPageQueryRequest): Promise<EntryPageResponse>;
  queryProducerPage(input: ProducerPageQueryRequest): Promise<ProducerPageResponse>;
  suggestTags(input: TagSuggestionQueryInput, signal?: AbortSignal): Promise<RelationSuggestionDto[]>;
  suggestProducers(input: ProducerSuggestionQueryInput, signal?: AbortSignal): Promise<RelationSuggestionDto[]>;
  searchTags(query: string, includeNsfw?: boolean): Promise<TagSearchHit[]>;
  listFacetFilterOptions(type: string, authorId?: number): Promise<FacetFilterOptions>;
  listGalleryTags(type?: string): Promise<EntryTagUsage[]>;
  createEntry(input: CreateEntryRequest): Promise<EntryRecordDto>;
  updateEntry(entryId: number, input: UpdateEntryRequest): Promise<EntryRecordDto>;
  deleteEntry(entryId: number): Promise<void>;
  uploadEntryMedia(
    entryId: number,
    kind: 'cover' | 'preview',
    file: File,
  ): Promise<EntryRecordDto>;
  /**
   * Why the Entry's images cannot be deleted or reordered right now, or null
   * when they can. A code rather than a sentence, so the page owns the wording.
   */
  getEntryMediaRemovalBlockReason?(entryId:number):Promise<EntryMediaRemovalBlockReason|null>;
  setEntryMediaOrder?(entryId: number, refs: string[]): Promise<EntryRecordDto>;
  previewSiteProbeFolder(files: File[]): Promise<ImportPreview>;
  /** The same preview for an export the server can read itself (a crawl T³ started). */
  previewSiteProbeExportPath(metadataPath: string): Promise<ImportPreview>;
  commitImport(batch: ImportBatch, mapping: ImportCommitMapping): Promise<ImportCommitResult>;
  /** Commit that export, storing its media from disk instead of from an upload. */
  commitImportPath(batch: ImportBatch, mapping: ImportCommitMapping): Promise<ImportCommitResult>;
  siteprobeStatus(): Promise<SiteprobeStatus>;
  siteprobeSites(): Promise<SiteprobeSitesEvent>;
  /** One site's own description of itself; `text` is empty when its folder has none. */
  siteprobeReadme(site: string): Promise<SiteprobeReadme>;
  /**
   * Open the folder a hand-made or downloaded adapter goes into, in the machine's file manager.
   *
   * The argument is a layer (`installed` is where a downloaded adapter goes), never a path — the
   * server resolves it from the tool's home.
   */
  revealSiteprobeFolder(folder: SiteprobeRevealFolder): Promise<SiteprobeRevealFolderResult>;
  /** A URL the browser can open for a file in the export tree (the review page). */
  siteprobeExportFileUrl(path: string, selectionRunId?: string): string;
  siteprobeResolve(input: SiteprobeResolveRequest): Promise<SiteprobeResolveEvent>;
  /** Read one pasted link with no site rule: title and cover, or a reason and a next step. */
  fetchSiteProbeLinkMeta(url: string): Promise<SiteprobeLinkMeta>;
  startSiteprobeRun(input: SiteprobeRunRequest): Promise<SiteprobeRun>;
  /**
   * Hand over a selection the browser downloaded: the tool reads files, and a download lands wherever
   * the browser puts it, so the bytes come back here and the server writes them beside the page.
   */
  uploadSiteprobeSelection(runId: string, upload: SiteprobeSelectionUpload): Promise<SiteprobeRun>;
  /** "I have signed in" — the line the login door is waiting for. */
  siteprobeLoginDone(runId: string): Promise<SiteprobeRun>;
  getSiteprobeRun(runId: string): Promise<SiteprobeRun>;
  /**
   * Every run this server is holding.
   *
   * A run is a live child process on the server, so leaving a page does not end it — the panel is
   * only its surface. This is what a panel asks on mount to take back a run it started before the
   * person went elsewhere: without it the process keeps running with nothing left to see or stop it.
   */
  listSiteprobeRuns(): Promise<SiteprobeRun[]>;
  cancelSiteprobeRun(runId: string): Promise<SiteprobeRun>;
  listTaxonomyAliases(vocabulary?: TaxonomyVocabulary): Promise<TaxonomyAliasDto[]>;
  upsertTaxonomyAlias(input: UpsertTaxonomyAliasRequest): Promise<TaxonomyAliasDto>;
  importTaxonomyAliases(input: ImportTaxonomyAliasesRequest): Promise<TaxonomyAliasImportResult>;
  /**
   * Bring every site's dictionary across from the tool's own export tree — the one-time move.
   *
   * The file picker above this is how a dictionary was imported by hand; every crawl has been writing
   * those files all along, and after this runs the alias table is the dictionary, so the export tree
   * is not part of the flow any more.
   */

  importSiteDictionaries(): Promise<SiteDictionaryImportResult>;
  deleteTaxonomyAlias(aliasId: number): Promise<void>;
  listAuthorAliasGroups(): Promise<AuthorAliasGroup[]>;
  saveAuthorAliasGroup(input: SaveAuthorAliasGroupRequest): Promise<SaveAuthorAliasGroupResponse>;
  planProducerMerge(): Promise<ProducerMergePlanResponse>;
  executeProducerMerge(): Promise<ProducerMergeResponse>;
  planTitleShortening(): Promise<TitleShorteningPlanResponse>;
  applyTitleShortening(
    changes: TitleShorteningChange[],
  ): Promise<ApplyTitleShorteningResponse>;
  applyEntryLayoutTemplate(entryId: number): Promise<LayoutTemplateApplyResponse>;
  applyEntryTagLayout(entryId: number): Promise<TagLayoutApplyResponse>;
  listLayout(type: string): Promise<ReturnType<typeof layoutResponseSchema.parse>>;
  getEntry(entryId: number): Promise<EntryDetailResponse>;
  listEntrySources(entryId: number): Promise<EntrySourceRecordDto[]>;
  listSourceLibrary(): Promise<SourceLibraryRecordDto[]>;
  getSyncCapabilities(options?: { replay?: boolean }): Promise<SyncCapabilities>;
  getEntrySyncIdentity?(entryId: number): Promise<SyncEntryIdentity>;
  getAuthorSyncIdentity?(authorId: number): Promise<SyncEntryIdentity>;
  getEntryConversionContext?(entryId:number):Promise<import('@t3/shared').SyncEntryConversionContext>;
  getCollectionCommonTagContext?(collectionId:number,name:string):Promise<import('@t3/shared').SyncCollectionCommonTagContext>;
  getCollectionSyncIdentity?(collectionId:number):Promise<import('@t3/shared').SyncCollectionIdentity>;
  /** Stable sync client identity for operation receipts; the online browser keeps one in localStorage. */
  getClientId?(): Promise<string>;
  /** Read-only bounded journal transport; records are NOT a complete snapshot projection. */
  fetchSyncChanges?(query: SyncChangesQuery): Promise<ReturnType<typeof syncChangesResponseSchema.parse>>;
  /** Drain the durable Outbox after a successful lightweight reachability probe. */
  replayOfflineOperations?(): Promise<void>;
  /** Open an installed snapshot first on cold start; probe the server separately. */
  preferOfflineSnapshot?(reason?: 'startup' | 'disconnect'): Promise<boolean>;
  /** Sidebar numbers that follow the show-hideable preference. */
  getNavigationCounts?(includeNsfw?: boolean): Promise<NavigationCounts>;
  fetchSyncSnapshot(options?: { media: 'none' | 'thumbnails' }): Promise<SyncSnapshot>;
  fetchSnapshotDelta?(request: SyncDeltaRequest): Promise<SyncDeltaPage>;
  ackSnapshotDelta?(request: SyncAckRequest): Promise<{ ackSeq: number }>;
  replaySyncOperation?(operation: SyncReplayRequest): Promise<SyncReplayResult>;
  uploadSyncMedia?(
    uploadId: string,
    metadata: SyncMediaUploadMetadata,
    blob: Blob,
  ): Promise<SyncMediaUploadResult>;
  enqueueOfflineEntryCreate?(
    input: OfflineEntryCreateRequest,
    transportError?: unknown,
  ): Promise<{ localKey: string }>;
  enqueueOfflinePendingEntryContent?(localKey: string, row: { contentType: string; content: string }): Promise<void>;
  getPendingOfflineEntryAuthorOptions?(localKey: string): Promise<PendingOfflineEntryAuthorOptions>;
  enqueueOfflinePendingEntryAuthors?(localKey: string, producerUids: string[]): Promise<void>;
  enqueueOfflinePendingEntryAuthorCreate?(localKey: string, name: string): Promise<PendingOfflineEntryAuthorValue>;
  getPendingOfflineEntryTagOptions?(localKey: string): Promise<PendingOfflineEntryTagOptions>;
  enqueueOfflinePendingEntryFacetCreate?(localKey: string, name: string, sectionId: number): Promise<void>;
  enqueueOfflinePendingEntryTags?(localKey: string, tags: PendingOfflineEntryTagValue[]): Promise<void>;
  enqueueOfflinePendingEntryTagCreate?(localKey: string, name: string, facetId: number): Promise<void>;
  listPendingOfflineEntryCreates?(): Promise<PendingOfflineEntryCreate[]>;
  flushOfflineOutbox?(): Promise<void>;
  discardBlockedOfflineOperations?(): Promise<void>;
  probeSourceTarget(homepage: string): Promise<{
    ok: true;
    adapterKey: string;
    displayName: string;
    origin: string;
  } | { ok: false; reason: string; detail: string }>;
  patchSourceStatus(sourceKey: string, patch: SourceStatusPatch): Promise<SourceStatusRecordDto>;
  createSourceMaintenanceRun(input: {
    originSourceKey: string;
    adapterKey: string;
    targetHomepage?: string;
    markOriginInvalid: boolean;
  }): Promise<SourceMaintenanceRunRecordDto>;
  getSourceMaintenanceRun(runId: number): Promise<SourceMaintenanceRunRecordDto>;
  startSourceMaintenanceRun(runId: number): Promise<SourceMaintenanceRunRecordDto>;
  pauseSourceMaintenanceRun(runId: number): Promise<SourceMaintenanceRunRecordDto>;
  resumeSourceMaintenanceRun(runId: number): Promise<SourceMaintenanceRunRecordDto>;
  cancelSourceMaintenanceRun(runId: number): Promise<SourceMaintenanceRunRecordDto>;
  listSourceMaintenanceItems(
    runId: number,
    query?: Partial<SourceMaintenanceItemPageQuery>,
  ): Promise<{ run: SourceMaintenanceRunRecordDto; items: SourceMaintenanceItemRecordDto[]; total: number }>;
  patchSourceMaintenanceItem(
    runId: number,
    entryId: number,
    patch: { decision?: 'pending' | 'accept' | 'skip' | 'conflict' | 'error'; selectedUrl?: string | null },
  ): Promise<SourceMaintenanceItemRecordDto>;
  commitSourceMaintenanceRun(runId: number): Promise<CommitSourceMaintenanceResponse>;

  mergeAuthorEntries(input: MergeAuthorEntriesRequest): Promise<MergeAuthorEntriesResponse>;
  convertEntryAuthors(entryId: number): Promise<ConvertEntryAuthorsResponse>;
  createEntryContent(
    entryId: number,
    input: CreateEntryContentRequest,
  ): Promise<ReturnType<typeof entryContentRecordSchema.parse>>;
  updateEntryContent(
    contentId: number,
    input: UpdateEntryContentRequest,
  ): Promise<ReturnType<typeof entryContentRecordSchema.parse>>;
  deleteEntryContent(contentId: number): Promise<void>;
  reorderEntryContents(entryId: number, orderedContentIds: number[]): Promise<void>;
  reorderSectionFacets(sectionId: number, orderedFacetIds: number[]): Promise<void>;
  createSection(input: CreateSectionRequest): Promise<{
    id: number;
    entryType: string;
    name: string;
    sortOrder: number;
    defaultFacetId: number;
  }>;
  createFacet(input: CreateFacetRequest): Promise<void>;
  createEntryRatingSlot(entryId: number, name: string): Promise<RatingSlotDto>;
  listRatingSlots(entryType: string): Promise<RatingSlotDto[]>;
  setEntryRating(entryId: number, slotId: number, stars: number | null): Promise<RatingRow>;
  reorderEntryRatingSlots(entryId: number, orderedSlotIds: number[]): Promise<void>;
  createAuthorRatingSlot(
    authorId: number,
    name: string,
    subjectKind?: 'producer' | 'author_self',
  ): Promise<RatingSlotDto>;
  setAuthorRating(authorId: number, slotId: number, stars: number | null): Promise<RatingRow>;
  reorderAuthorRatingSlots(authorId: number, orderedSlotIds: number[]): Promise<void>;
  /** Pin the Author to a Gallery: the partition both of their rating classes live in. */
  setAuthorGalleryAnchor(authorId: number, galleryType: string): Promise<void>;
  /** Removes one rating dimension from its Gallery — every subject of that partition loses it. */
  getEntryRatingLayoutContext?(entryId: number, predecessorOpId?: string): Promise<import('@t3/shared').SyncEntryRatingLayoutContext>;
  getEntryRatingLayoutSettlement?(layoutUid: string, opId: string): Promise<import('@t3/shared').SyncEntryRatingLayoutSettlement>;
  deleteEntryRatingSlot(entryId: number, slotId: number): Promise<void>;
  deleteAuthorRatingSlot(authorId: number, slotId: number): Promise<void>;
  deleteFacet(facetId: number): Promise<void>;
  /**
   * Rename a Section. A Section and a Facet are both tag groups, so the route is the tag-group one;
   * this is the name for what the caller has in hand.
   */
  renameSection(sectionId: number, name: string): Promise<void>;
  /** Delete a Section. The server refuses one that still has tags assigned, and says so. */
  deleteSection(sectionId: number): Promise<void>;
  getGalleryPartitionContext?(entryType: string, predecessorOpId?: string): Promise<import('@t3/shared').SyncGalleryPartitionContext>;
  setGalleryPartition(entryType: string, nsfw: boolean): Promise<void>;
  /**
   * The card shape a Gallery shows: the wall, or the horizontal card a long title needs. It is the
   * Gallery's own choice, stored beside its hideable flag, so it is set once instead of every visit.
   */
  listGalleryCardLayouts(): Promise<Array<{ type: string; layout: GalleryCardLayout }>>;
  setGalleryCardLayout(entryType: string, layout: GalleryCardLayout): Promise<void>;
  listCollections(kind: CollectionKind, includeNsfw?: boolean): Promise<CollectionRecordDto[]>;
  createCollection(input: { kind: CollectionKind; title: string; description?: string; parentId?: number; galleryType?: string | undefined }): Promise<CollectionRecordDto>;
  createTemporaryCollection(entryIds: number[]): Promise<TemporaryCollectionResponse>;
  updateCollection(collectionId: number, input: { title?: string; description?: string }): Promise<CollectionRecordDto>;
  deleteCollection(collectionId: number): Promise<void>;
  /** One tag on every work this folder holds, child folders included. */
  addCollectionTag(collectionId: number, name: string): Promise<{
    tagId: number | null;
    entriesAffected: number;
    alreadyPresent: number;
    skipped: number;
  }>;
  setCollectionNsfw(collectionId: number, nsfw: boolean): Promise<CollectionRecordDto>;
  reorderCollections(kind: CollectionKind, orderedCollectionIds: number[]): Promise<void>;
  addCollectionEntry(collectionId: number, entryId: number): Promise<void>;
  removeCollectionEntry(collectionId: number, entryId: number): Promise<void>;
  addCollectionProducer(collectionId: number, producerId: number): Promise<void>;
  removeCollectionProducer(collectionId: number, producerId: number): Promise<void>;
  listCollectionsForEntry(entryId: number): Promise<number[]>;
  listTemplates(): Promise<TemplateSummary[]>;
  /** The common template — repository content every Gallery can start from. */
  commonTemplate(): Promise<CommonTemplate>;
  /** Give a Gallery with no template of its own the common one, as its own Sections and Facets. */
  applyCommonTemplate(entryType: string): Promise<ApplyCommonTemplateResponse>;
  /**
   * Back-fill the common template's rating dimensions into a Gallery that applied the template
   * before it carried any. Idempotent.
   */
  applyCommonTemplateRatingSlots(entryType: string): Promise<ApplyCommonTemplateResponse>;
  /**
   * The Content kinds a work of this Gallery carries (built-ins plus the kinds its works use), so the
   * editor can offer them instead of asking the person to type a kind that already exists.
   */
  listContentKinds(entryType: string): Promise<string[]>;
  mergeTag(input: {
    vocabulary: 'entry' | 'producer';
    keptTagId: number;
    mergedTagIds: number[];
  }): Promise<{ keptTagId: number; movedAssignments: number; skippedDuplicates: number; deletedTags: number }>;
  deleteTag(input: {
    vocabulary: 'entry' | 'producer';
    tagId: number;
  }): Promise<{ tagId: number; tagName: string; removedAssignments: number; deletedTags: number }>;
  listCollectionsForProducer(producerId: number): Promise<number[]>;
  recordEntryView(entryId: number): Promise<UsageInfo>;
  likeEntry(entryId: number): Promise<UsageInfo>;
  assignEntryTag(entryId: number, input: AssignEntryTagRequest): Promise<EntryTagAssignment | null>;
  moveEntryTag(entryId: number, tagId: number, targetFacetId: number): Promise<void>;
  renameEntryTag(entryId: number, tagId: number, name: string): Promise<void>;
  removeEntryTag(entryId: number, tagId: number): Promise<void>;
  listAuthors(): Promise<Array<{
    id: number;
    name: string;
    covers: string[];
    galleryType: string | null;
    viewCount: number;
    likeCount: number;
    lastViewedAt: string | null;
    nsfw: boolean;
  }>>;
  listAuthorFilterOptions(entryType?: string, includeNsfw?: boolean): Promise<AuthorFilterOptions>;
  getAuthor(authorId: number): Promise<AuthorDetailResponse>;
  createAuthor(input: CreateProducerRequest): Promise<ProducerRecordDto>;
  updateAuthor(authorId: number, input: UpdateProducerRequest): Promise<ProducerRecordDto>;
  linkEntryAuthor(entryId: number, authorId: number): Promise<void>;
  linkEntryAuthorByName(entryId: number, name: string): Promise<{
    entryId: number;
    producerId: number;
    producerName: string;
    created: boolean;
    matchedAlias?: string;
  }>;
  unlinkEntryAuthor(entryId: number, authorId: number): Promise<void>;
  deleteAuthor(authorId: number): Promise<void>;
  assignAuthorTag(authorId: number, name: string): Promise<void>;
  renameAuthorTag(authorId: number, tagId: number, name: string): Promise<void>;
  removeAuthorTag(authorId: number, tagId: number): Promise<void>;
  createAuthorDirectory(
    authorId: number,
    input: CreateAuthorDirectoryRequest,
  ): Promise<AuthorDirectoryDto>;
  updateAuthorDirectory(
    directoryId: number,
    input: UpdateAuthorDirectoryRequest,
  ): Promise<AuthorDirectoryDto>;
  moveEntryToAuthorDirectory(
    authorId: number,
    directoryId: number,
    entryId: number,
  ): Promise<AuthorDirectoryDto>;
  removeEntryFromAuthorDirectory(
    authorId: number,
    directoryId: number,
    entryId: number,
  ): Promise<AuthorDirectoryDto>;
}

const CAPACITOR_HTTP_INTERCEPTOR = '/_capacitor_http_interceptor_';

export function resolveAssetUrl(
  path: string,
  assetBase = '',
  capacitorServerUrl?: string,
): string {
  // Object URLs (a queued offline create's staged cover) are already
  // addresses of the bytes themselves.
  if (path.startsWith('blob:')) return path;
  const resolved = /^https?:\/\//u.test(path) ? path : `${assetBase}${path.replace(/^\/+/, '')}`;
  if (!capacitorServerUrl?.trim()
    || !/^https?:\/\//u.test(resolved)
    || resolved.includes(CAPACITOR_HTTP_INTERCEPTOR)) {
    return resolved;
  }
  // The shell's virtual origin is not remote media: the WebView's own request
  // interception serves these through the native pinned transport, and handing
  // them to the Capacitor HTTP interceptor would bypass that pairing channel.
  if (new URL(resolved).origin === new URL(capacitorServerUrl).origin) {
    return resolved;
  }
  const proxyUrl = new URL(capacitorServerUrl);
  proxyUrl.pathname = CAPACITOR_HTTP_INTERCEPTOR;
  proxyUrl.search = '';
  proxyUrl.hash = '';
  proxyUrl.searchParams.append('u', resolved);
  return proxyUrl.toString();
}

export function createGalleryApi(
  client: ApiClient,
  assetBase = '',
  capacitorServerUrl?: string,
): GalleryApi {
  return {
    assetUrl(path) {
      return resolveAssetUrl(path, assetBase, capacitorServerUrl);
    },
    async getViewLaterState() {
      return viewLaterStateSchema.parse(await client.request('view-later'));
    },
    async addViewLaterEntry(entryId) {
      return viewLaterStateSchema.parse(await client.request(`view-later/${entryId}`, {
        method: 'PUT',
      }));
    },
    async removeViewLaterEntry(entryId) {
      return viewLaterStateSchema.parse(await client.request(`view-later/${entryId}`, {
        method: 'DELETE',
      }));
    },
    async mergeViewLaterEntries(entryIds) {
      return viewLaterStateSchema.parse(await client.request('view-later/merge', {
        method: 'POST',
        body: mergeViewLaterRequestSchema.parse({ entryIds }),
      }));
    },
    async addViewLaterAuthor(authorId) {
      return viewLaterStateSchema.parse(await client.request(`view-later/producers/${authorId}`, {
        method: 'PUT',
      }));
    },
    async removeViewLaterAuthor(authorId) {
      return viewLaterStateSchema.parse(await client.request(`view-later/producers/${authorId}`, {
        method: 'DELETE',
      }));
    },
    async setGalleryOrder(types) {
      const answer = await client.request('galleries/order', {
        method: 'PUT',
        body: setGalleryOrderRequestSchema.parse({ types }),
      });
      return galleryOrderResponseSchema.parse(answer).types;
    },

    async listGalleries() {
      return gallerySummarySchema.array().parse(await client.request('galleries'));
    },
    async queryEntryPage(input) {
      return entryPageResponseSchema.parse(await client.request('entries/query', {
        method: 'POST',
        query: { coverText: '1' },
        body: entryPageQueryRequestSchema.parse(input),
      }));
    },
    async suggestTags(input, signal) {
      const parsed = tagSuggestionQuerySchema.parse(input);
      return relationSuggestionResponseSchema.parse(await client.request('suggestions/tags', {
        query: {
          vocabulary: parsed.vocabulary,
          q: parsed.q,
          limit: parsed.limit,
          excludeIds: parsed.excludeIds.join(','),
          entryType: parsed.entryType,
          facetId: parsed.facetId,
          includeNsfw: parsed.includeNsfw,
        },
        ...(signal === undefined ? {} : { signal }),
      }));
    },
    async suggestProducers(input, signal) {
      const parsed = producerSuggestionQuerySchema.parse(input);
      return relationSuggestionResponseSchema.parse(await client.request('suggestions/producers', {
        query: {
          q: parsed.q,
          limit: parsed.limit,
          excludeIds: parsed.excludeIds.join(','),
        },
        ...(signal === undefined ? {} : { signal }),
      }));
    },
    async searchTags(query, includeNsfw = true) {
      return tagSearchHitSchema.array().parse(await client.request('search/tags', {
        query: { q: query, includeNsfw: String(includeNsfw) },
      }));
    },
    async queryProducerPage(input) {
      return producerPageResponseSchema.parse(await client.request('producers/query', {
        method: 'POST',
        body: producerPageQueryRequestSchema.parse(input),
      }));
    },
    async listFacetFilterOptions(type, authorId) {
      return facetFilterOptionsResponseSchema.parse(
        await client.request(`entries/facet-options/${encodeURIComponent(type)}`, {
          query: authorId === undefined ? {} : { authorId: String(authorId) },
        }),
      );
    },
    async listGalleryTags(type) {
      return entryTagUsageSchema.array().parse(await client.request('entry-tags', {
        query: { entryType: type },
      }));
    },
    async createEntry(input) {
      return entryRecordSchema.parse(await client.request('entries', {
        method: 'POST',
        body: createEntryRequestSchema.parse(input),
      }));
    },
    async updateEntry(entryId, input) {
      return entryRecordSchema.parse(await client.request(`entries/${entryId}`, {
        method: 'PATCH',
        body: updateEntryRequestSchema.parse(input),
      }));
    },
    async deleteEntry(entryId) {
      await client.request(`entries/${entryId}`, { method: 'DELETE' });
    },
    async uploadEntryMedia(entryId, kind, file) {
      const formData = new FormData();
      formData.set('file', file);
      return entryRecordSchema.parse(await client.request(`entries/${entryId}/media/${kind}`, {
        method: 'PUT',
        formData,
      }));
    },
    async previewSiteProbeFolder(files) {
      const jsonFiles = files
        .map((file) => ({
          file,
          path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        }))
        .filter(({ path }) => path.toLocaleLowerCase().endsWith('.json'));
      const root = jsonFiles
        .filter(({ path }) => path.toLocaleLowerCase().endsWith('metadata.json'))
        .sort((left, right) => left.path.split('/').length - right.path.split('/').length)[0];
      if (!root) throw new Error('The selected folder has no root metadata.json');
      const formData = new FormData();
      formData.set('rootPath', root.path);
      for (const candidate of jsonFiles) {
        formData.append('paths', candidate.path);
        formData.append('files', candidate.file, candidate.file.name);
      }
      return importPreviewSchema.parse(await client.request('imports/site-probe/preview', {
        method: 'POST',
        formData,
      }));
    },
    async commitImport(batch, mapping) {
      return importCommitResultSchema.parse(await client.request('imports/commit', {
        method: 'POST',
        body: importCommitRequestSchema.parse({ batch, mapping }),
      }));
    },


    async previewSiteProbeExportPath(metadataPath) {
      return importPreviewSchema.parse(await client.request('imports/site-probe/preview-path', {
        method: 'POST',
        body: { metadataPath },
      }));
    },

    async commitImportPath(batch, mapping) {
      return importCommitResultSchema.parse(await client.request('imports/commit-path', {
        method: 'POST',
        body: importCommitRequestSchema.parse({ batch, mapping }),
      }));
    },

    async siteprobeStatus() {
      return siteprobeStatusSchema.parse(await client.request('siteprobe/status'));
    },

    async siteprobeSites() {
      return siteprobeSitesEventSchema.parse(await client.request('siteprobe/sites'));
    },

    async fetchSiteProbeLinkMeta(url) {
      return siteprobeLinkMetaSchema.parse(await client.request('siteprobe/link-meta', {
        method: 'POST',
        body: siteprobeLinkRequestSchema.parse({ url }),
      }));
    },

    async siteprobeReadme(site) {
      return siteprobeReadmeSchema.parse(await client.request('siteprobe/readme', {
        query: { site },
      }));
    },

    async revealSiteprobeFolder(folder) {
      // A layer name, never a path: the server picks the folder from the tool's own home, so a
      // compromised page cannot make the local server open arbitrary directories.
      return siteprobeRevealFolderSchema.parse(await client.request('siteprobe/reveal-folder', {
        method: 'POST',
        body: siteprobeRevealFolderRequestSchema.parse({ folder }),
      }));
    },

    siteprobeExportFileUrl(path, selectionRunId) {
      // Built here rather than in the panel so the one guarded route has one address, and through
      // the same resolver every other asset URL goes through — a phone build reaches the API
      // through an interceptor, and a hand-built URL would bypass it. The server refuses anything
      // outside the export tree, so a wrong path is a refusal rather than a read.
      const query = new URLSearchParams({ path });
      if (selectionRunId) query.set('selectionRunId', selectionRunId);
      return resolveAssetUrl(
        `/api/siteprobe/export-file?${query.toString()}`,
        assetBase,
        capacitorServerUrl,
      );
    },

    async siteprobeResolve(input) {
      return siteprobeResolveEventSchema.parse(await client.request('siteprobe/resolve', {
        method: 'POST',
        body: siteprobeResolveRequestSchema.parse(input),
      }));
    },

    async startSiteprobeRun(input) {
      return siteprobeRunSchema.parse(await client.request('siteprobe/runs', {
        method: 'POST',
        body: siteprobeRunRequestSchema.parse(input),
      }));
    },

    async uploadSiteprobeSelection(runId, upload) {
      return siteprobeRunSchema.parse(await client.request(`siteprobe/runs/${runId}/selection`, {
        method: 'POST',
        body: siteprobeSelectionUploadSchema.parse(upload),
      }));
    },

    async siteprobeLoginDone(runId) {
      return siteprobeRunSchema.parse(await client.request(
        `siteprobe/runs/${runId}/login-done`, { method: 'POST' }));
    },

    async getSiteprobeRun(runId) {
      return siteprobeRunSchema.parse(await client.request(`siteprobe/runs/${runId}`));
    },

    async listSiteprobeRuns() {
      // The server wraps them (`{ runs: [...] }`) so the answer can grow a field without becoming a
      // different shape; each entry is the same object `getSiteprobeRun` returns.
      const answer = await client.request('siteprobe/runs') as { runs?: unknown[] };
      return (answer.runs ?? []).map((run) => siteprobeRunSchema.parse(run));
    },

    async cancelSiteprobeRun(runId) {
      return siteprobeRunSchema.parse(await client.request(`siteprobe/runs/${runId}/cancel`, {
        method: 'POST',
      }));
    },
    async listTaxonomyAliases(vocabulary) {
      return taxonomyAliasSchema.array().parse(await client.request('taxonomy-aliases', {
        query: { vocabulary, includeTags: '1' },
      }));
    },
    async upsertTaxonomyAlias(input) {
      return taxonomyAliasSchema.parse(await client.request('taxonomy-aliases', {
        method: 'POST',
        body: upsertTaxonomyAliasRequestSchema.parse(input),
      }));
    },
    async importSiteDictionaries() {
      return siteDictionaryImportResultSchema.parse(
        await client.request('taxonomy-aliases/import-site-dictionaries', { method: 'POST' }),
      );
    },

    async importTaxonomyAliases(input) {
      return taxonomyAliasImportResultSchema.parse(await client.request('taxonomy-aliases/import', {
        method: 'POST',
        body: importTaxonomyAliasesRequestSchema.parse(input),
      }));
    },
    async deleteTaxonomyAlias(aliasId) {
      await client.request(`taxonomy-aliases/${aliasId}`, { method: 'DELETE' });
    },
    async listAuthorAliasGroups() {
      return authorAliasGroupsResponseSchema.parse(
        await client.request('author-alias-groups'),
      ).groups;
    },
    async saveAuthorAliasGroup(input) {
      return saveAuthorAliasGroupResponseSchema.parse(await client.request('author-alias-groups', {
        method: 'POST',
        body: saveAuthorAliasGroupRequestSchema.parse(input),
      }));
    },
    async planProducerMerge() {
      return producerMergePlanResponseSchema.parse(
        await client.request('producers/merge/plan', { method: 'POST' }),
      );
    },
    async executeProducerMerge() {
      return producerMergeResponseSchema.parse(
        await client.request('producers/merge', { method: 'POST' }),
      );
    },
    async planTitleShortening() {
      return titleShorteningPlanResponseSchema.parse(
        await client.request('entries/titles/plan', { method: 'POST' }),
      );
    },
    async applyTitleShortening(changes) {
      return applyTitleShorteningResponseSchema.parse(
        await client.request('entries/titles/apply', {
          method: 'POST',
          body: applyTitleShorteningRequestSchema.parse({ changes }),
        }),
      );
    },
    async applyEntryLayoutTemplate(entryId) {
      return layoutTemplateApplyResponseSchema.parse(
        await client.request(`entries/${entryId}/template/apply`, { method: 'POST' }),
      );
    },
    async applyEntryTagLayout(entryId) {
      return tagLayoutApplyResponseSchema.parse(
        await client.request(`entries/${entryId}/tag-layout/apply`, { method: 'POST' }),
      );
    },
    async listLayout(type) {
      return layoutResponseSchema.parse(await client.request(`layouts/${encodeURIComponent(type)}`));
    },
    async getEntry(entryId) {
      return entryDetailResponseSchema.parse(await client.request(`entries/${entryId}`));
    },
    async listEntrySources(entryId) {
      return entrySourceRecordSchema.array().parse(await client.request(`entries/${entryId}/sources`));
    },
    async listSourceLibrary() {
      return sourceLibraryRecordSchema.array().parse(await client.request('source-library'));
    },
    async getSyncCapabilities() {
      return syncCapabilitiesSchema.parse(await client.request('sync/capabilities'));
    },
    async getEntryConversionContext(entryId) {
      const {syncEntryConversionContextSchema}=await import('@t3/shared');
      return syncEntryConversionContextSchema.parse(await client.request(`entries/${entryId}/conversion-context`));
    },
    async getCollectionCommonTagContext(collectionId,name) {
      const {syncCollectionCommonTagContextSchema}=await import('@t3/shared');
      return syncCollectionCommonTagContextSchema.parse(await client.request(`collections/${collectionId}/common-tag-context`,{query:{name}}));
    },
    async getCollectionSyncIdentity(collectionId) {
      return syncCollectionIdentitySchema.parse(await client.request(`collections/${collectionId}/sync-identity`));
    },
    async getAuthorSyncIdentity(authorId) {
      return syncEntryIdentitySchema.parse(await client.request(`producers/${authorId}/sync-identity`));
    },
    async getEntrySyncIdentity(entryId) {
      return syncEntryIdentitySchema.parse(await client.request(`entries/${entryId}/sync-identity`));
    },
    async getClientId() {
      return stableBrowserClientId();
    },
    async getNavigationCounts(includeNsfw = true) {
      return navigationCountsSchema.parse(await client.request('navigation-counts', {
        query: { includeNsfw: String(includeNsfw) },
      }));
    },
    async fetchSyncSnapshot(options) {
      return syncSnapshotSchema.parse(await client.request(`sync/snapshot?media=${options?.media ?? 'thumbnails'}`));
    },
    async fetchSnapshotDelta(request) {
      return syncDeltaPageSchema.parse(await client.request('sync/delta', {method:'POST',body:syncDeltaRequestSchema.parse(request)}));
    },
    async ackSnapshotDelta(request) {
      return syncAckResponseSchema.parse(await client.request('sync/ack', {method:'POST',body:syncAckRequestSchema.parse(request)}));
    },
    async fetchSyncChanges(query) {
      return syncChangesResponseSchema.parse(await client.request('sync/changes', {
        query: syncChangesQuerySchema.parse(query),
      }));
    },
    async replaySyncOperation(operation) {
      return syncReplayResultSchema.parse(await client.request('sync/replay', {
        method: 'POST',
        body: syncReplayRequestSchema.parse(operation),
      }));
    },
    async uploadSyncMedia(uploadId, metadata, blob) {
      const normalized = syncMediaUploadMetadataSchema.parse(metadata);
      const formData = new FormData();
      formData.set('metadata', JSON.stringify(normalized));
      formData.set('file', blob, `${normalized.kind}-offline`);
      return syncMediaUploadResultSchema.parse(await client.request(`sync/media/${uploadId}`, {
        method: 'PUT',
        formData,
      }));
    },
    async probeSourceTarget(homepage) {
      let response: { ok: boolean; adapterKey?: string; displayName?: string; origin?: string; reason?: string; detail?: string };
      try {
        response = await client.request('source-maintenance/adapter-probe', {
          method: 'POST',
          body: { homepage },
        }) as typeof response;
      } catch (cause) {
        if (cause instanceof ApiError) {
          const payload = cause.payload as { reason?: string; detail?: string } | null;
          return { ok: false, reason: payload?.reason ?? 'unsupported', detail: payload?.detail ?? '' };
        }
        throw cause;
      }
      if (response.ok === true && response.adapterKey !== undefined) {
        return {
          ok: true,
          adapterKey: response.adapterKey,
          displayName: response.displayName ?? response.adapterKey,
          origin: response.origin ?? '',
        };
      }
      return { ok: false, reason: response.reason ?? 'unsupported', detail: response.detail ?? '' };
    },
    async patchSourceStatus(sourceKey, patch) {
      return sourceStatusRecordSchema.parse(await client.request(`source-statuses/${encodeURIComponent(sourceKey)}`, {
        method: 'PATCH',
        body: sourceStatusPatchSchema.parse(patch),
      }));
    },
    async createSourceMaintenanceRun(input) {
      const parsed = createSourceMaintenanceRunRequestSchema.parse(input);
      return client.request('source-maintenance/runs', {
        method: 'POST',
        body: parsed,
      }) as Promise<SourceMaintenanceRunRecordDto>;
    },
    async getSourceMaintenanceRun(runId) {
      return client.request(`source-maintenance/runs/${runId}`) as Promise<SourceMaintenanceRunRecordDto>;
    },
    async startSourceMaintenanceRun(runId) {
      return client.request(`source-maintenance/runs/${runId}/start`, { method: 'POST' }) as Promise<SourceMaintenanceRunRecordDto>;
    },
    async pauseSourceMaintenanceRun(runId) {
      return client.request(`source-maintenance/runs/${runId}/pause`, { method: 'POST' }) as Promise<SourceMaintenanceRunRecordDto>;
    },
    async resumeSourceMaintenanceRun(runId) {
      return client.request(`source-maintenance/runs/${runId}/resume`, { method: 'POST' }) as Promise<SourceMaintenanceRunRecordDto>;
    },
    async cancelSourceMaintenanceRun(runId) {
      return client.request(`source-maintenance/runs/${runId}/cancel`, { method: 'POST' }) as Promise<SourceMaintenanceRunRecordDto>;
    },
    async listSourceMaintenanceItems(runId, query) {
      const parsed = sourceMaintenanceItemPageQuerySchema.parse(query ?? {});
      const search = new URLSearchParams();
      if (parsed.page !== 1) search.set('page', String(parsed.page));
      if (parsed.pageSize !== 20) search.set('pageSize', String(parsed.pageSize));
      if (parsed.state !== 'all') search.set('state', parsed.state);
      const suffix = search.toString() === '' ? '' : `?${search.toString()}`;
      return sourceMaintenanceItemPageResponseSchema.parse(
        await client.request(`source-maintenance/runs/${runId}/items${suffix}`),
      );
    },
    async patchSourceMaintenanceItem(runId, entryId, patch) {
      return client.request(`source-maintenance/runs/${runId}/items/${entryId}`, {
        method: 'PATCH',
        body: sourceMaintenanceItemPatchSchema.parse(patch),
      }) as Promise<SourceMaintenanceItemRecordDto>;
    },
    async commitSourceMaintenanceRun(runId) {
      return commitSourceMaintenanceResponseSchema.parse(await client.request(`source-maintenance/runs/${runId}/commit`, {
        method: 'POST',
        body: commitSourceMaintenanceRequestSchema.parse({}),
      }));
    },

    async mergeAuthorEntries(input) {
      return mergeAuthorEntriesResponseSchema.parse(await client.request('entries/merge', {
        method: 'POST',
        body: mergeAuthorEntriesRequestSchema.parse(input),
      }));
    },
    async convertEntryAuthors(entryId) {
      return convertEntryAuthorsResponseSchema.parse(
        await client.request(`entries/${entryId}/multi-author`, { method: 'POST' }),
      );
    },
    async setEntryMediaOrder(entryId, refs) {
      return entryRecordSchema.parse(await client.request(`entries/${entryId}/media/order`, {
        method: 'PUT',
        body: setEntryMediaOrderRequestSchema.parse({ refs }),
      }));
    },
    async createEntryContent(entryId, input) {
      return entryContentRecordSchema.parse(await client.request(`entries/${entryId}/contents`, {
        method: 'POST',
        body: createEntryContentRequestSchema.parse(input),
      }));
    },
    async updateEntryContent(contentId, input) {
      return entryContentRecordSchema.parse(await client.request(`contents/${contentId}`, {
        method: 'PATCH',
        body: updateEntryContentRequestSchema.parse(input),
      }));
    },
    async deleteEntryContent(contentId) {
      await client.request(`contents/${contentId}`, { method: 'DELETE' });
    },
    async reorderEntryContents(entryId, orderedContentIds) {
      await client.request(`entries/${entryId}/contents/order`, {
        method: 'PUT',
        body: reorderEntryContentsRequestSchema.parse({ orderedContentIds }),
      });
    },
    async reorderSectionFacets(sectionId, orderedFacetIds) {
      await client.request(`sections/${sectionId}/facets/order`, {
        method: 'PUT',
        body: reorderSectionFacetsRequestSchema.parse({ orderedFacetIds }),
      });
    },
    async createSection(input) {
      return createSectionResponseSchema.parse(await client.request('sections', {
        method: 'POST',
        body: createSectionRequestSchema.parse(input),
      }));
    },
    async createFacet(input) {
      await client.request('facets', {
        method: 'POST',
        body: createFacetRequestSchema.parse(input),
      });
    },
    async createEntryRatingSlot(entryId, name) {
      return ratingSlotSchema.parse(await client.request(`entries/${entryId}/rating-slots`, {
        method: 'POST',
        body: createRatingSlotRequestSchema.parse({ name }),
      }));
    },
    async listRatingSlots(entryType) {
      return ratingSlotSchema.array().parse(await client.request('rating-slots', {
        query: { entryType },
      }));
    },
    async setEntryRating(entryId, slotId, stars) {
      return ratingRowSchema.parse(await client.request(`entries/${entryId}/ratings`, {
        method: 'PUT',
        body: setRatingRequestSchema.parse({ slotId, stars }),
      }));
    },
    async reorderEntryRatingSlots(entryId, orderedSlotIds) {
      await client.request(`entries/${entryId}/rating-slots/order`, {
        method: 'PUT',
        body: reorderRatingSlotsRequestSchema.parse({ orderedSlotIds }),
      });
    },
    async createAuthorRatingSlot(
      authorId,
      name,
      subjectKind: 'producer' | 'author_self' = 'producer',
    ) {
      return ratingSlotSchema.parse(await client.request(`producers/${authorId}/rating-slots`, {
        method: 'POST',
        body: createAuthorRatingSlotRequestSchema.parse({ name, subjectKind }),
      }));
    },
    async setAuthorRating(authorId, slotId, stars) {
      return ratingRowSchema.parse(await client.request(`producers/${authorId}/ratings`, {
        method: 'PUT',
        body: setRatingRequestSchema.parse({ slotId, stars }),
      }));
    },
    async setAuthorGalleryAnchor(authorId, galleryType) {
      await client.request(`producers/${authorId}/gallery-anchor`, {
        method: 'PUT',
        body: setProducerGalleryAnchorRequestSchema.parse({ galleryType }),
      });
    },
    async getEntryRatingLayoutContext(entryId, predecessorOpId) {
      return syncEntryRatingLayoutContextSchema.parse(await client.request(`entries/${entryId}/rating-layout-context${predecessorOpId ? `?predecessorOpId=${encodeURIComponent(predecessorOpId)}` : ''}`));
    },
    async getEntryRatingLayoutSettlement(layoutUid, opId) {
      return syncEntryRatingLayoutSettlementSchema.parse(await client.request(`rating-layouts/${encodeURIComponent(layoutUid)}/operations/${encodeURIComponent(opId)}`));
    },
    async deleteEntryRatingSlot(entryId, slotId) {
      await client.request(`entries/${entryId}/rating-slots/${slotId}`, { method: 'DELETE' });
    },
    async deleteAuthorRatingSlot(authorId, slotId) {
      await client.request(`producers/${authorId}/rating-slots/${slotId}`, { method: 'DELETE' });
    },
    async reorderAuthorRatingSlots(authorId, orderedSlotIds) {
      await client.request(`producers/${authorId}/rating-slots/order`, {
        method: 'PUT',
        body: reorderRatingSlotsRequestSchema.parse({ orderedSlotIds }),
      });
    },
    async deleteFacet(facetId) {
      await client.request(`facets/${facetId}`, { method: 'DELETE' });
    },
    async renameSection(sectionId, name) {
      await client.request(`tag-groups/${sectionId}/name`, {
        method: 'PATCH',
        body: renameTagGroupRequestSchema.parse({ name }),
      });
    },
    async deleteSection(sectionId) {
      await client.request(`sections/${sectionId}`, { method: 'DELETE' });
    },
    async likeEntry(entryId) {

      return usageInfoSchema.parse(await client.request(`entries/${entryId}/likes`, {
        method: 'POST',
      }));
    },
    async listCollections(kind, includeNsfw = true) {
      return collectionRecordSchema.array().parse(await client.request('collections', {
        query: { kind, compact: 'true', includeNsfw: String(includeNsfw) },
      }));
    },
    async createCollection(input) {
      return collectionRecordSchema.parse(await client.request('collections', {
        method: 'POST',
        body: createCollectionRequestSchema.parse(input),
      }));
    },
    async createTemporaryCollection(entryIds) {
      return temporaryCollectionResponseSchema.parse(
        await client.request('collections/temporary', {
          method: 'POST',
          body: createTemporaryCollectionRequestSchema.parse({ entryIds }),
        }),
      );
    },
    async updateCollection(collectionId, input) {
      return collectionRecordSchema.parse(await client.request(`collections/${collectionId}`, {
        method: 'PATCH',
        body: updateCollectionRequestSchema.parse(input),
      }));
    },
    async addCollectionTag(collectionId, name) {
      return addCollectionTagResponseSchema.parse(await client.request(
        `collections/${collectionId}/tags`,
        { method: 'POST', body: addCollectionTagRequestSchema.parse({ name }) },
      ));
    },
    async deleteCollection(collectionId) {
      await client.request(`collections/${collectionId}`, { method: 'DELETE' });
    },
    async setCollectionNsfw(collectionId, nsfw) {
      return collectionRecordSchema.parse(await client.request(`collections/${collectionId}/nsfw`, {
        method: 'PUT',
        body: { nsfw },
      }));
    },
    async reorderCollections(kind, orderedCollectionIds) {
      await client.request('collections/order', {
        method: 'PUT',
        query: { kind },
        body: reorderCollectionsRequestSchema.parse({ orderedCollectionIds }),
      });
    },
    async addCollectionEntry(collectionId, entryId) {
      await client.request(`collections/${collectionId}/entries/${entryId}`, { method: 'PUT' });
    },
    async removeCollectionEntry(collectionId, entryId) {
      await client.request(`collections/${collectionId}/entries/${entryId}`, { method: 'DELETE' });
    },
    async addCollectionProducer(collectionId, producerId) {
      await client.request(`collections/${collectionId}/producers/${producerId}`, { method: 'PUT' });
    },
    async removeCollectionProducer(collectionId, producerId) {
      await client.request(`collections/${collectionId}/producers/${producerId}`, { method: 'DELETE' });
    },
    async deleteTag(input) {
      return client.request('tags/delete', {
        method: 'POST',
        body: tagDeleteRequestSchema.parse(input),
      }) as Promise<{ tagId: number; tagName: string; removedAssignments: number; deletedTags: number }>;
    },
    async mergeTag(input) {
      return client.request('tags/merge', {
        method: 'POST',
        body: tagMergeRequestSchema.parse(input),
      }) as Promise<{ keptTagId: number; movedAssignments: number; skippedDuplicates: number; deletedTags: number }>;
    },
    async listTemplates() {
      return templateSummarySchema.array().parse(await client.request('templates'));
    },
    async commonTemplate() {
      return commonTemplateSchema.parse(await client.request('templates/common'));
    },
    async applyCommonTemplate(entryType) {
      return applyCommonTemplateResponseSchema.parse(
        await client.request('templates/common/apply', {
          method: 'POST',
          body: applyCommonTemplateRequestSchema.parse({ entryType }),
        }),
      );
    },
    async applyCommonTemplateRatingSlots(entryType) {
      return applyCommonTemplateResponseSchema.parse(
        await client.request('templates/common/rating-slots/apply', {
          method: 'POST',
          body: applyCommonTemplateRequestSchema.parse({ entryType }),
        }),
      );
    },
    async listContentKinds(entryType) {
      const response = contentKindsResponseSchema.parse(
        await client.request(`content-kinds/${encodeURIComponent(entryType)}`),
      );
      return response.kinds;
    },
    async listCollectionsForEntry(entryId) {
      return numberIdListSchema.parse(await client.request(`collections/for-entry/${entryId}`));
    },
    async listCollectionsForProducer(producerId) {
      return numberIdListSchema.parse(await client.request(`collections/for-producer/${producerId}`));
    },
    async getGalleryPartitionContext(entryType, predecessorOpId) {
      return syncGalleryPartitionContextSchema.parse(await client.request(`galleries/${encodeURIComponent(entryType)}/partition-context${predecessorOpId ? `?predecessorOpId=${encodeURIComponent(predecessorOpId)}` : ''}`));
    },
    async setGalleryPartition(entryType, nsfw) {
      await client.request(`galleries/${encodeURIComponent(entryType)}/partition`, {
        method: 'PUT',
        body: galleryPartitionRequestSchema.parse({ nsfw }),
      });
    },
    async listGalleryCardLayouts() {
      return galleryCardLayoutsResponseSchema.parse(
        await client.request('galleries/card-layouts'),
      ).layouts;
    },
    async setGalleryCardLayout(entryType, layout) {
      await client.request(`galleries/${encodeURIComponent(entryType)}/card-layout`, {
        method: 'PUT',
        body: galleryCardLayoutRequestSchema.parse({ layout }),
      });
    },
    async recordEntryView(entryId) {
      return usageInfoSchema.parse(await client.request(`entries/${entryId}/views`, {
        method: 'POST',
      }));
    },
    async assignEntryTag(entryId, input) {
      // The assignment names the tag the server just linked: the caller can show
      // it without re-reading the whole Entry over the network.
      return entryTagAssignmentSchema.parse(await client.request(`entries/${entryId}/tags`, {
        method: 'POST',
        body: assignEntryTagRequestSchema.parse(input),
      }));
    },
    async moveEntryTag(entryId, tagId, targetFacetId) {
      await client.request(`entries/${entryId}/tags/${tagId}`, {
        method: 'PATCH',
        body: moveEntryTagRequestSchema.parse({ targetFacetId }),
      });
    },
    async renameEntryTag(entryId, tagId, name) {
      entryTagAssignmentSchema.parse(await client.request(`entries/${entryId}/tags/${tagId}/name`, {
        method: 'PATCH',
        body: renameEntryTagRequestSchema.parse({ name }),
      }));
    },
    async removeEntryTag(entryId, tagId) {
      await client.request(`entries/${entryId}/tags/${tagId}`, { method: 'DELETE' });
    },
    async listAuthors() {
      return producerSummarySchema.array().parse(await client.request('producers'));
    },
    async listAuthorFilterOptions(entryType, includeNsfw = true) {
      return authorFilterOptionsResponseSchema.parse(await client.request('producers/filter-options', {
        query: {
          ...(entryType === undefined ? {} : { entryType }),
          includeNsfw: String(includeNsfw),
        },
      }));
    },
    async getAuthor(authorId) {
      return authorDetailResponseSchema.parse(await client.request(`producers/${authorId}`));
    },
    async createAuthor(input) {
      return producerRecordSchema.parse(await client.request('producers', {
        method: 'POST',
        body: createProducerRequestSchema.parse(input),
      }));
    },
    async updateAuthor(authorId, input) {
      return producerRecordSchema.parse(await client.request(`producers/${authorId}`, {
        method: 'PATCH',
        body: updateProducerRequestSchema.parse(input),
      }));
    },
    async linkEntryAuthor(entryId, authorId) {
      await client.request(`entries/${entryId}/producers/${authorId}`, { method: 'PUT' });
    },
    async linkEntryAuthorByName(entryId, name) {
      return client.request(`entries/${entryId}/producers/link-by-name`, {
        method: 'POST',
        body: { name },
      }) as Promise<{ entryId: number; producerId: number; producerName: string; created: boolean; matchedAlias?: string }>;
    },
    async unlinkEntryAuthor(entryId, authorId) {
      await client.request(`entries/${entryId}/producers/${authorId}`, { method: 'DELETE' });
    },
    async deleteAuthor(authorId) {
      await client.request(`producers/${authorId}`, { method: 'DELETE' });
    },
    async assignAuthorTag(authorId, name) {
      producerTagAssignmentSchema.parse(await client.request(`producers/${authorId}/tags`, {
        method: 'POST',
        body: assignProducerTagRequestSchema.parse({ name }),
      }));
    },
    async renameAuthorTag(authorId, tagId, name) {
      producerTagAssignmentSchema.parse(
        await client.request(`producers/${authorId}/tags/${tagId}/name`, {
          method: 'PATCH',
          body: renameProducerTagRequestSchema.parse({ name }),
        }),
      );
    },
    async removeAuthorTag(authorId, tagId) {
      await client.request(`producers/${authorId}/tags/${tagId}`, { method: 'DELETE' });
    },
    async createAuthorDirectory(authorId, input) {
      return authorDirectorySchema.parse(await client.request(`producers/${authorId}/directories`, {
        method: 'POST',
        body: createAuthorDirectoryRequestSchema.parse(input),
      }));
    },
    async updateAuthorDirectory(directoryId, input) {
      return authorDirectorySchema.parse(await client.request(`author-directories/${directoryId}`, {
        method: 'PATCH',
        body: updateAuthorDirectoryRequestSchema.parse(input),
      }));
    },
    async moveEntryToAuthorDirectory(authorId, directoryId, entryId) {
      return authorDirectorySchema.parse(await client.request(
        `producers/${authorId}/directories/${directoryId}/entries/${entryId}`,
        { method: 'PUT' },
      ));
    },
    async removeEntryFromAuthorDirectory(authorId, directoryId, entryId) {
      return authorDirectorySchema.parse(await client.request(
        `producers/${authorId}/directories/${directoryId}/entries/${entryId}`,
        { method: 'DELETE' },
      ));
    },
  };
}

export function resolveDefaultApiBaseUrl(
  configuredBaseUrl: string | undefined,
  production: boolean,
  origin: string,
  runtimeBaseUrl?: string,
  nativeShell = false,
): string {
  if (nativeShell) {
    // The shell's virtual origin is the standing API base: the injected fetch
    // routes it through the native pinned transport, and an unpaired shell
    // answers 401 so the app can show its pairing screen. Throwing here would
    // kill the bundle at module scope and leave the shell a white board — the
    // base is valid with or without a completed pairing.
    const pairedBase = runtimeBaseUrl?.trim();
    if (pairedBase === 'https://localhost/api/' || pairedBase === 'https://localhost/api') {
      return 'https://localhost/api/';
    }
    const candidateOrigin = pairedBase?.endsWith('/api/')
      ? pairedBase.slice(0, -'/api/'.length) : null;
    const pairedOrigin = normalizeTrustedLanHttpOrigin(candidateOrigin);
    if (!pairedOrigin || pairedBase !== `${pairedOrigin}/api/`) {
      throw new Error('Pair with a private-LAN server before making API requests');
    }
    return pairedBase;
  }
  if (configuredBaseUrl?.trim()) return configuredBaseUrl;
  if (runtimeBaseUrl?.trim()) return runtimeBaseUrl;
  return production
    ? new URL('/api/', origin).toString()
    : 'http://127.0.0.1:8765/api/';
}

export function createDefaultGalleryApi(): GalleryApi {
  const baseUrl = resolveDefaultApiBaseUrl(
    import.meta.env.VITE_API_BASE_URL,
    import.meta.env.PROD,
    window.location.origin,
    document.querySelector<HTMLMetaElement>('meta[name="t3-api-base-url"]')?.content,
    document.querySelector('meta[name="t3-native-shell"]') !== null,
  );
  const capacitorServerUrl = (window as Window & {
    Capacitor?: { getServerUrl?: () => string };
  }).Capacitor?.getServerUrl?.();
  return createGalleryApi(
    createApiClient({ baseUrl }),
    new URL('/', baseUrl).toString(),
    capacitorServerUrl,
  );
}
