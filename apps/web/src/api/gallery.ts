import {
  assignProducerTagRequestSchema,
  assignEntryTagRequestSchema,
  authorDetailResponseSchema,
  authorDirectorySchema,
  authorFilterOptionsResponseSchema,
  createAuthorDirectoryRequestSchema,
  createEntryContentRequestSchema,
  createEntryRequestSchema,
  createProducerRequestSchema,
  createFacetRequestSchema,
  createRatingSlotRequestSchema,
  createSectionRequestSchema,
  entryDetailResponseSchema,
  entryContentRecordSchema,
  entryRecordSchema,
  entrySummarySchema,
  entryTagAssignmentSchema,
  entryTagUsageSchema,
  facetFilterEntriesRequestSchema,
  facetFilterOptionsResponseSchema,
  collectionRecordSchema,
  createCollectionRequestSchema,
  galleryPartitionRequestSchema,
  gallerySummarySchema,
  importCommitRequestSchema,
  importCommitResultSchema,
  importPreviewSchema,
  importTaxonomyAliasesRequestSchema,
  layoutResponseSchema,
  layoutTemplateApplyResponseSchema,
  moveEntryTagRequestSchema,
  producerRecordSchema,
  producerMergePlanResponseSchema,
  producerMergeResponseSchema,
  producerSummarySchema,
  producerTagAssignmentSchema,
  renameEntryTagRequestSchema,
  renameProducerTagRequestSchema,
  reorderEntryContentsRequestSchema,
  reorderSectionFacetsRequestSchema,
  ratingRowSchema,
  ratingSlotSchema,
  numberIdListSchema,
  reorderCollectionsRequestSchema,
  reorderRatingSlotsRequestSchema,
  setRatingRequestSchema,
  updateCollectionRequestSchema,
  tagLayoutApplyResponseSchema,
  tagSearchHitSchema,
  templateSummarySchema,
  taxonomyAliasSchema,
  unassignedTagGroupsResponseSchema,
  unassignedTagMoveRequestSchema,
  unassignedTagMoveResponseSchema,
  usageInfoSchema,
  upsertTaxonomyAliasRequestSchema,
  authorAliasGroupsResponseSchema,
  saveAuthorAliasGroupRequestSchema,
  saveAuthorAliasGroupResponseSchema,
  updateEntryContentRequestSchema,
  updateAuthorDirectoryRequestSchema,
  updateProducerRequestSchema,
  type AuthorDetailResponse,
  type AuthorDirectoryDto,
  type AuthorFilterOptions,
  type CreateAuthorDirectoryRequest,
  type AssignEntryTagRequest,
  type CreateEntryContentRequest,
  type CreateEntryRequest,
  type CreateFacetRequest,
  type CreateSectionRequest,
  type EntryDetailResponse,
  type EntryRecordDto,
  type EntryTagUsage,
  type FacetFilterCondition,
  type FacetFilterOptions,
  type RatingFilterCondition,
  type RatingSort,
  type GallerySummary,
  type ImportBatch,
  type UnassignedTagGroups,
  type UnassignedTagMoveRequest,
  type UsageFilterCondition,
  type UsageSort,
  type UsageInfo,
  type UnassignedTagMoveResponse,
  type ImportCommitMapping,
  type ImportCommitResult,
  type ImportPreview,
  type ImportTaxonomyAliasesRequest,
  type CreateProducerRequest,
  type ProducerRecordDto,
  type ProducerMergePlanResponse,
  type ProducerMergeResponse,
  type AuthorAliasGroup,
  type SaveAuthorAliasGroupRequest,
  type SaveAuthorAliasGroupResponse,
  type CollectionKind,
  type CollectionRecordDto,
  type TemplateSummary,
  type RatingRow,
  type RatingSlotDto,
  type LayoutTemplateApplyResponse,
  type TagLayoutApplyResponse,
  type TagSearchHit,
  type TaxonomyAliasDto,
  type TaxonomyVocabulary,
  type UpsertTaxonomyAliasRequest,
  type UpdateAuthorDirectoryRequest,
  type UpdateProducerRequest,
  type UpdateEntryContentRequest,
} from '@t3/shared';
import { createApiClient, type ApiClient } from './client.js';

export interface GalleryEntrySummary {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRef: string | null;
  previewRefs: string[];
  uploadDate: string | null;
  pageCount: number | null;
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

export interface EntryListFilters {
  includeTagIds?: number[];
  excludeTagIds?: number[];
}

export interface GalleryApi {
  assetUrl(path: string): string;
  listGalleries(): Promise<GallerySummary[]>;
  listEntries(type: string, filters?: EntryListFilters): Promise<GalleryEntrySummary[]>;
  searchEntries(query: string, entryType?: string): Promise<GalleryEntrySummary[]>;
  searchTags(query: string, includeNsfw?: boolean): Promise<TagSearchHit[]>;
  searchAuthors(query: string): Promise<GalleryAuthorSummary[]>;
  listFacetFilterOptions(type: string, authorId?: number): Promise<FacetFilterOptions>;
  filterEntriesByFacets(
    type: string,
    conditions: FacetFilterCondition[],
    authorIds: number[],
    options?: {
      ratingConditions?: RatingFilterCondition[];
      ratingSort?: RatingSort | null;
      usageConditions?: UsageFilterCondition[];
      usageSort?: UsageSort | null;
    },
  ): Promise<GalleryEntrySummary[]>;
  findEntriesByTag(tagId: number): Promise<GalleryEntrySummary[]>;
  listGalleryTags(type?: string): Promise<EntryTagUsage[]>;
  listUnassignedTags(): Promise<UnassignedTagGroups>;
  moveUnassignedTag(input: UnassignedTagMoveRequest): Promise<UnassignedTagMoveResponse>;
  createEntry(input: CreateEntryRequest): Promise<EntryRecordDto>;
  deleteEntry(entryId: number): Promise<void>;
  uploadEntryMedia(
    entryId: number,
    kind: 'cover' | 'preview',
    file: File,
  ): Promise<EntryRecordDto>;
  previewSiteProbeFolder(files: File[]): Promise<ImportPreview>;
  commitImport(batch: ImportBatch, mapping: ImportCommitMapping): Promise<ImportCommitResult>;
  listTaxonomyAliases(vocabulary?: TaxonomyVocabulary): Promise<TaxonomyAliasDto[]>;
  upsertTaxonomyAlias(input: UpsertTaxonomyAliasRequest): Promise<TaxonomyAliasDto>;
  importTaxonomyAliases(input: ImportTaxonomyAliasesRequest): Promise<TaxonomyAliasDto[]>;
  deleteTaxonomyAlias(aliasId: number): Promise<void>;
  listAuthorAliasGroups(): Promise<AuthorAliasGroup[]>;
  saveAuthorAliasGroup(input: SaveAuthorAliasGroupRequest): Promise<SaveAuthorAliasGroupResponse>;
  planProducerMerge(): Promise<ProducerMergePlanResponse>;
  executeProducerMerge(): Promise<ProducerMergeResponse>;
  applyEntryLayoutTemplate(entryId: number): Promise<LayoutTemplateApplyResponse>;
  applyEntryTagLayout(entryId: number): Promise<TagLayoutApplyResponse>;
  listLayout(type: string): Promise<ReturnType<typeof layoutResponseSchema.parse>>;
  getEntry(entryId: number): Promise<EntryDetailResponse>;
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
  createSection(input: CreateSectionRequest): Promise<void>;
  createFacet(input: CreateFacetRequest): Promise<void>;
  createEntryRatingSlot(entryId: number, name: string): Promise<RatingSlotDto>;
  listRatingSlots(entryType: string): Promise<RatingSlotDto[]>;
  setEntryRating(entryId: number, slotId: number, stars: number | null): Promise<RatingRow>;
  reorderEntryRatingSlots(entryId: number, orderedSlotIds: number[]): Promise<void>;
  createAuthorRatingSlot(authorId: number, name: string): Promise<RatingSlotDto>;
  setAuthorRating(authorId: number, slotId: number, stars: number | null): Promise<RatingRow>;
  reorderAuthorRatingSlots(authorId: number, orderedSlotIds: number[]): Promise<void>;
  deleteFacet(facetId: number): Promise<void>;
  setGalleryPartition(entryType: string, nsfw: boolean): Promise<void>;
  listCollections(kind: CollectionKind): Promise<CollectionRecordDto[]>;
  getCollection(collectionId: number): Promise<CollectionRecordDto>;
  createCollection(input: { kind: CollectionKind; title: string; description?: string; parentId?: number }): Promise<CollectionRecordDto>;
  updateCollection(collectionId: number, input: { title?: string; description?: string }): Promise<CollectionRecordDto>;
  deleteCollection(collectionId: number): Promise<void>;
  setCollectionNsfw(collectionId: number, nsfw: boolean): Promise<CollectionRecordDto>;
  reorderCollections(kind: CollectionKind, orderedCollectionIds: number[]): Promise<void>;
  addCollectionEntry(collectionId: number, entryId: number): Promise<void>;
  removeCollectionEntry(collectionId: number, entryId: number): Promise<void>;
  addCollectionProducer(collectionId: number, producerId: number): Promise<void>;
  removeCollectionProducer(collectionId: number, producerId: number): Promise<void>;
  listCollectionsForEntry(entryId: number): Promise<number[]>;
  listTemplates(): Promise<TemplateSummary[]>;
  listCollectionsForProducer(producerId: number): Promise<number[]>;
  recordEntryView(entryId: number): Promise<UsageInfo>;
  likeEntry(entryId: number): Promise<UsageInfo>;
  assignEntryTag(entryId: number, input: AssignEntryTagRequest): Promise<void>;
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
  filterAuthors(ownTagIds: number[], relatedEntryTagIds: number[]): Promise<GalleryAuthorSummary[]>;
  findAuthorsByTag(tagId: number): Promise<Array<{ id: number; name: string }>>;
  getAuthor(authorId: number): Promise<AuthorDetailResponse>;
  createAuthor(input: CreateProducerRequest): Promise<ProducerRecordDto>;
  updateAuthor(authorId: number, input: UpdateProducerRequest): Promise<ProducerRecordDto>;
  linkEntryAuthor(entryId: number, authorId: number): Promise<void>;
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

export function createGalleryApi(client: ApiClient, assetBase = ''): GalleryApi {
  return {
    assetUrl(path) {
      return /^https?:\/\//u.test(path) ? path : `${assetBase}${path.replace(/^\/+/, '')}`;
    },
    async listGalleries() {
      return gallerySummarySchema.array().parse(await client.request('galleries'));
    },
    async listEntries(type, filters = {}) {
      return entrySummarySchema.array().parse(await client.request('entries', {
        query: {
          entryType: type,
          includeTagIds: filters.includeTagIds?.join(','),
          excludeTagIds: filters.excludeTagIds?.join(','),
        },
      }));
    },
    async searchEntries(query, entryType) {
      return entrySummarySchema.array().parse(await client.request('search/entries', {
        query: { q: query, ...(entryType === undefined ? {} : { entryType }) },
      }));
    },
    async searchTags(query, includeNsfw = true) {
      return tagSearchHitSchema.array().parse(await client.request('search/tags', {
        query: { q: query, includeNsfw: String(includeNsfw) },
      }));
    },
    async searchAuthors(query) {
      return producerSummarySchema.array().parse(await client.request('search/producers', {
        query: { q: query },
      }));
    },
    async listFacetFilterOptions(type, authorId) {
      return facetFilterOptionsResponseSchema.parse(
        await client.request(`entries/facet-options/${encodeURIComponent(type)}`, {
          query: authorId === undefined ? {} : { authorId: String(authorId) },
        }),
      );
    },
    async filterEntriesByFacets(type, conditions, authorIds, options = {}) {
      return entrySummarySchema.array().parse(await client.request('entries/filter', {
        method: 'POST',
        body: facetFilterEntriesRequestSchema.parse({
          entryType: type,
          conditions,
          authorIds,
          ratingConditions: options.ratingConditions ?? [],
          ratingSort: options.ratingSort ?? null,
          usageConditions: options.usageConditions ?? [],
          usageSort: options.usageSort ?? null,
        }),
      }));
    },
    async findEntriesByTag(tagId) {
      return entrySummarySchema.array().parse(await client.request('entries', {
        query: { includeTagIds: String(tagId) },
      }));
    },
    async listGalleryTags(type) {
      return entryTagUsageSchema.array().parse(await client.request('entry-tags', {
        query: { entryType: type },
      }));
    },
    async listUnassignedTags() {
      return unassignedTagGroupsResponseSchema.parse(
        await client.request('tags/unassigned'),
      );
    },
    async moveUnassignedTag(input) {
      return unassignedTagMoveResponseSchema.parse(await client.request('tags/unassigned/move', {
        method: 'POST',
        body: unassignedTagMoveRequestSchema.parse(input),
      }));
    },
    async createEntry(input) {
      return entryRecordSchema.parse(await client.request('entries', {
        method: 'POST',
        body: createEntryRequestSchema.parse(input),
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
    async listTaxonomyAliases(vocabulary) {
      return taxonomyAliasSchema.array().parse(await client.request('taxonomy-aliases', {
        query: { vocabulary },
      }));
    },
    async upsertTaxonomyAlias(input) {
      return taxonomyAliasSchema.parse(await client.request('taxonomy-aliases', {
        method: 'POST',
        body: upsertTaxonomyAliasRequestSchema.parse(input),
      }));
    },
    async importTaxonomyAliases(input) {
      return taxonomyAliasSchema.array().parse(await client.request('taxonomy-aliases/import', {
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
      await client.request('sections', {
        method: 'POST',
        body: createSectionRequestSchema.parse(input),
      });
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
    async createAuthorRatingSlot(authorId, name) {
      return ratingSlotSchema.parse(await client.request(`producers/${authorId}/rating-slots`, {
        method: 'POST',
        body: createRatingSlotRequestSchema.parse({ name }),
      }));
    },
    async setAuthorRating(authorId, slotId, stars) {
      return ratingRowSchema.parse(await client.request(`producers/${authorId}/ratings`, {
        method: 'PUT',
        body: setRatingRequestSchema.parse({ slotId, stars }),
      }));
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
    async likeEntry(entryId) {
      return usageInfoSchema.parse(await client.request(`entries/${entryId}/likes`, {
        method: 'POST',
      }));
    },
    async listCollections(kind) {
      return collectionRecordSchema.array().parse(await client.request('collections', {
        query: { kind },
      }));
    },
    async getCollection(collectionId) {
      return collectionRecordSchema.parse(await client.request(`collections/${collectionId}`));
    },
    async createCollection(input) {
      return collectionRecordSchema.parse(await client.request('collections', {
        method: 'POST',
        body: createCollectionRequestSchema.parse(input),
      }));
    },
    async updateCollection(collectionId, input) {
      return collectionRecordSchema.parse(await client.request(`collections/${collectionId}`, {
        method: 'PATCH',
        body: updateCollectionRequestSchema.parse(input),
      }));
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
    async listTemplates() {
      return templateSummarySchema.array().parse(await client.request('templates'));
    },
    async listCollectionsForEntry(entryId) {
      return numberIdListSchema.parse(await client.request(`collections/for-entry/${entryId}`));
    },
    async listCollectionsForProducer(producerId) {
      return numberIdListSchema.parse(await client.request(`collections/for-producer/${producerId}`));
    },
    async setGalleryPartition(entryType, nsfw) {
      await client.request(`galleries/${encodeURIComponent(entryType)}/partition`, {
        method: 'PUT',
        body: galleryPartitionRequestSchema.parse({ nsfw }),
      });
    },
    async recordEntryView(entryId) {
      return usageInfoSchema.parse(await client.request(`entries/${entryId}/views`, {
        method: 'POST',
      }));
    },
    async assignEntryTag(entryId, input) {
      entryTagAssignmentSchema.parse(await client.request(`entries/${entryId}/tags`, {
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
    async filterAuthors(ownTagIds, relatedEntryTagIds) {
      return producerSummarySchema.array().parse(await client.request('producers', {
        query: {
          ownTagIds: ownTagIds.join(','),
          relatedEntryTagIds: relatedEntryTagIds.join(','),
        },
      }));
    },
    async findAuthorsByTag(tagId) {
      return producerSummarySchema.array().parse(await client.request('producers', {
        query: { ownTagIds: String(tagId) },
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
): string {
  if (configuredBaseUrl?.trim()) return configuredBaseUrl;
  return production
    ? new URL('/api/', origin).toString()
    : 'http://127.0.0.1:8765/api/';
}

export function createDefaultGalleryApi(): GalleryApi {
  const baseUrl = resolveDefaultApiBaseUrl(
    import.meta.env.VITE_API_BASE_URL,
    import.meta.env.PROD,
    window.location.origin,
  );
  return createGalleryApi(createApiClient({ baseUrl }), new URL('/', baseUrl).toString());
}
