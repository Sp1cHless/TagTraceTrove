import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  apiErrorResponseSchema,
  authorDetailResponseSchema,
  authorDirectoryIdParamsSchema,
  authorDirectorySchema,
  assignEntryTagRequestSchema,
  assignProducerTagRequestSchema,
  contentIdParamsSchema,
  createEntryContentRequestSchema,
  createAuthorDirectoryRequestSchema,
  createEntryRequestSchema,
  createFacetRequestSchema,
  createFacetResponseSchema,
  createProducerRequestSchema,
  createSectionRequestSchema,
  createSectionResponseSchema,
  entryContentRecordSchema,
  entryDetailResponseSchema,
  entryIdParamsSchema,
  entryProducerParamsSchema,
  entryRecordSchema,
  entrySummarySchema,
  entryTagAssignmentSchema,
  entryTagUsageSchema,
  entryTypeParamsSchema,
  entryTypeQuerySchema,
  facetFilterEntriesRequestSchema,
  facetFilterOptionsResponseSchema,
  facetIdParamsSchema,
  findEntriesQuerySchema,
  findProducersQuerySchema,
  gallerySummarySchema,
  importBatchSchema,
  importCommitMappingSchema,
  importTaxonomyAliasesRequestSchema,
  layoutResponseSchema,
  layoutTemplateApplyResponseSchema,
  moveEntryTagRequestSchema,
  mutationSuccessResponseSchema,
  producerIdParamsSchema,
  producerMergePlanResponseSchema,
  producerMergeResponseSchema,
  producerRecordSchema,
  producerSummarySchema,
  producerTagAssignmentSchema,
  renameEntryTagRequestSchema,
  renameProducerTagRequestSchema,
  renameTagGroupRequestSchema,
  reorderEntryContentsRequestSchema,
  reorderSectionFacetsRequestSchema,
  reorderTagGroupRequestSchema,
  sectionIdParamsSchema,
  tagGroupIdParamsSchema,
  tagIdParamsSchema,
  tagLayoutApplyResponseSchema,
  taxonomyAliasIdParamsSchema,
  taxonomyAliasesQuerySchema,
  taxonomyAliasSchema,
  upsertTaxonomyAliasRequestSchema,
  updateEntryContentRequestSchema,
  updateAuthorDirectoryRequestSchema,
  updateEntryRequestSchema,
  updateProducerRequestSchema,
} from '@t3/shared';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z, ZodError, type ZodType } from 'zod';
import type { T3Database } from '../database/connection.js';
import { inspectDatabase } from '../database/doctor.js';
import { commitImportBatch } from '../import/commit.js';
import {
  executeProducerMerges,
  planProducerMerges,
} from '../import/merge-producers.js';
import { deleteEntryMedia, readEntryMedia, storeEntryMedia, type EntryMediaKind } from '../import/media.js';
import { previewSiteProbeUpload } from '../import/upload-preview.js';
import {
  createEntryContent,
  deleteEntryContent,
  reorderEntryContents,
  updateEntryContent,
} from '../repositories/entry-content-repository.js';
import {
  createEntry,
  deleteEntry,
  getEntryDetail,
  listGalleries,
  updateEntry,
} from '../repositories/entry-repository.js';
import {
  applyEntryTagLayout,
  assignEntryTag,
  findEntriesByFacetFilters,
  findEntriesByTags,
  listEntryTags,
  listEntryTagsForType,
  listFacetFilterOptions,
  moveEntryTag,
  renameEntryTag,
  removeEntryTag,
} from '../repositories/entry-tag-repository.js';
import {
  applyLayoutTemplate,
  createFacet,
  createSection,
  deleteFacet,
  deleteSection,
  listLayout,
  renameTagGroup,
  reorderSectionFacets,
  reorderTagGroup,
} from '../repositories/layout-repository.js';
import {
  createProducer,
  deleteProducer,
  getAuthorDetail,
  linkEntryProducer,
  unlinkEntryProducer,
  updateProducer,
} from '../repositories/producer-repository.js';
import {
  addEntryToAuthorDirectory,
  createAuthorDirectory,
  removeEntryFromAuthorDirectory,
  updateAuthorDirectory,
} from '../repositories/author-directory-repository.js';
import {
  assignProducerTag,
  findProducers,
  listProducerTags,
  renameProducerTag,
  removeProducerTag,
} from '../repositories/producer-tag-repository.js';
import {
  deleteTaxonomyAlias,
  importTaxonomyAliases,
  listTaxonomyAliases,
  upsertTaxonomyAlias,
} from '../repositories/taxonomy-repository.js';

async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  return schema.parse(await request.json());
}

function errorPayload(
  code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR',
  message: string,
  details?: unknown,
) {
  return apiErrorResponseSchema.parse({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function isSqliteConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('SQLITE_CONSTRAINT');
}

function isDomainConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.startsWith('cannot ')
    || error.message.startsWith('content reorder must ');
}

export interface ApiAppOptions {
  assetRoot?: string;
  /** Live database path, used for the merge backup snapshot. */
  databasePath?: string;
  /**
   * Directory of a built web app (`apps/web/dist`). When set, non-`/api` GET
   * requests are served from it (files first, then a single-page fallback to
   * `index.html` for client-side routes). API-only mode when omitted.
   */
  staticRoot?: string;
}

export function createApiApp(database: T3Database, options: ApiAppOptions = {}): Hono {
  const app = new Hono();

  app.use('/api/*', cors({
    origin: (origin) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(origin)
      ? origin
      : undefined,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }));

  app.post('/api/entries', async (context) => {
    const input = await parseJson(context.req.raw, createEntryRequestSchema);
    return context.json(entryRecordSchema.parse(createEntry(database, input)), 201);
  });

  app.put('/api/entries/:entryId/media/:kind', async (context) => {
    if (!options.assetRoot) {
      return context.json(errorPayload('CONFLICT', 'Managed media storage is unavailable'), 409);
    }
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const kind = context.req.param('kind');
    if (kind !== 'cover' && kind !== 'preview') {
      return context.json(errorPayload('VALIDATION_ERROR', 'Invalid Entry media kind'), 400);
    }
    const body = await context.req.raw.formData();
    const file = body.get('file');
    const uploadedFile = typeof file === 'object'
      && file !== null
      && 'arrayBuffer' in file
      && typeof file.arrayBuffer === 'function'
      && 'type' in file
      && typeof file.type === 'string'
      && 'size' in file
      && typeof file.size === 'number'
      ? file
      : null;
    if (!uploadedFile || !uploadedFile.type.startsWith('image/') || uploadedFile.size > 20 * 1024 * 1024) {
      return context.json(errorPayload(
        'VALIDATION_ERROR',
        'Entry media must be an image no larger than 20 MB',
      ), 400);
    }
    const stored = await storeEntryMedia(database, options.assetRoot, {
      entryId,
      kind: kind as EntryMediaKind,
      mimeType: uploadedFile.type,
      bytes: new Uint8Array(await uploadedFile.arrayBuffer()),
    });
    return context.json(entryRecordSchema.parse(stored.entry));
  });

  app.get('/api/assets/entries/:entryId/:fileName', async (context) => {
    if (!options.assetRoot) return context.notFound();
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const media = await readEntryMedia(options.assetRoot, entryId, context.req.param('fileName'));
    if (!media) return context.notFound();
    const body = media.bytes.buffer.slice(
      media.bytes.byteOffset,
      media.bytes.byteOffset + media.bytes.byteLength,
    ) as ArrayBuffer;
    return context.body(body, 200, {
      'Content-Type': media.mimeType,
      'Cache-Control': 'no-store',
    });
  });

  app.post('/api/imports/site-probe/preview', async (context) => {
    const preview = await previewSiteProbeUpload(await context.req.raw.formData());
    return context.json(preview);
  });

  app.post('/api/imports/commit', async (context) => {
    const raw: unknown = await context.req.raw.json();
    if (typeof raw !== 'object' || raw === null || !('batch' in raw) || !('mapping' in raw)) {
      return context.json(errorPayload('VALIDATION_ERROR', 'Invalid Import commit request'), 400);
    }
    const batch = importBatchSchema.parse(raw.batch);
    const mapping = importCommitMappingSchema.parse(raw.mapping);
    return context.json(commitImportBatch(database, batch, mapping), 201);
  });

  app.get('/api/taxonomy-aliases', (context) => {
    const { vocabulary } = taxonomyAliasesQuerySchema.parse(context.req.query());
    return context.json(taxonomyAliasSchema.array().parse(listTaxonomyAliases(database, vocabulary)));
  });

  app.post('/api/taxonomy-aliases', async (context) => {
    const input = await parseJson(context.req.raw, upsertTaxonomyAliasRequestSchema);
    return context.json(taxonomyAliasSchema.parse(upsertTaxonomyAlias(database, input)), 201);
  });

  app.post('/api/taxonomy-aliases/import', async (context) => {
    const { aliases } = await parseJson(context.req.raw, importTaxonomyAliasesRequestSchema);
    return context.json(taxonomyAliasSchema.array().parse(importTaxonomyAliases(database, aliases)), 201);
  });

  app.delete('/api/taxonomy-aliases/:aliasId', (context) => {
    const { aliasId } = taxonomyAliasIdParamsSchema.parse({ aliasId: context.req.param('aliasId') });
    deleteTaxonomyAlias(database, aliasId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.get('/api/galleries', (context) => context.json(
    gallerySummarySchema.array().parse(listGalleries(database)),
  ));

  app.get('/api/entry-tags', (context) => {
    const { entryType } = entryTypeQuerySchema.parse(context.req.query());
    return context.json(entryTagUsageSchema.array().parse(
      listEntryTagsForType(database, entryType),
    ));
  });

  app.patch('/api/entries/:entryId', async (context) => {
    const { entryId } = entryIdParamsSchema.parse(context.req.param());
    const input = await parseJson(context.req.raw, updateEntryRequestSchema);
    return context.json(entryRecordSchema.parse(updateEntry(database, entryId, input)));
  });

  app.delete('/api/entries/:entryId', async (context) => {
    const { entryId } = entryIdParamsSchema.parse(context.req.param());
    deleteEntry(database, entryId);
    if (options.assetRoot) {
      await deleteEntryMedia(options.assetRoot, entryId);
    }
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.get('/api/entries/:entryId', (context) => {
    const { entryId } = entryIdParamsSchema.parse(context.req.param());
    const detail = getEntryDetail(database, entryId);
    if (!detail) {
      return context.json(errorPayload('NOT_FOUND', 'Entry not found'), 404);
    }
    return context.json(entryDetailResponseSchema.parse(detail));
  });

  app.get('/api/entries', (context) => {
    const query = findEntriesQuerySchema.parse(
      Object.fromEntries(new URL(context.req.url).searchParams),
    );
    return context.json(entrySummarySchema.array().parse(findEntriesByTags(database, query)));
  });

  app.get('/api/entries/facet-options/:entryType', (context) => {
    const { entryType } = entryTypeParamsSchema.parse({
      entryType: context.req.param('entryType'),
    });
    // Optional ?authorId= scopes the aggregation to one Author's works (the
    // Author page filter bar); omitted = whole gallery.
    const query = z.strictObject({
      authorId: z.coerce.number().int().positive().optional(),
    }).parse(Object.fromEntries(new URL(context.req.url).searchParams));
    return context.json(
      facetFilterOptionsResponseSchema.parse(
        listFacetFilterOptions(database, entryType, query.authorId ?? null),
      ),
    );
  });

  app.post('/api/entries/filter', async (context) => {
    const input = await parseJson(context.req.raw, facetFilterEntriesRequestSchema);
    return context.json(entrySummarySchema.array().parse(findEntriesByFacetFilters(database, input)));
  });

  app.post('/api/sections', async (context) => {
    const input = await parseJson(context.req.raw, createSectionRequestSchema);
    return context.json(createSectionResponseSchema.parse(createSection(database, input)), 201);
  });

  app.post('/api/facets', async (context) => {
    const input = await parseJson(context.req.raw, createFacetRequestSchema);
    return context.json(createFacetResponseSchema.parse(createFacet(database, input)), 201);
  });

  app.put('/api/sections/:sectionId/facets/order', async (context) => {
    const { sectionId } = sectionIdParamsSchema.parse({ sectionId: context.req.param('sectionId') });
    const input = await parseJson(context.req.raw, reorderSectionFacetsRequestSchema);
    reorderSectionFacets(database, sectionId, input.orderedFacetIds);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.get('/api/layouts/:entryType', (context) => {
    const { entryType } = entryTypeParamsSchema.parse(context.req.param());
    return context.json(layoutResponseSchema.parse(listLayout(database, entryType)));
  });

  app.patch('/api/tag-groups/:groupId/name', async (context) => {
    const { groupId } = tagGroupIdParamsSchema.parse({ groupId: context.req.param('groupId') });
    const input = await parseJson(context.req.raw, renameTagGroupRequestSchema);
    renameTagGroup(database, groupId, input.name);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.patch('/api/tag-groups/:groupId/order', async (context) => {
    const { groupId } = tagGroupIdParamsSchema.parse({ groupId: context.req.param('groupId') });
    const input = await parseJson(context.req.raw, reorderTagGroupRequestSchema);
    reorderTagGroup(database, groupId, input.sortOrder);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.delete('/api/facets/:facetId', (context) => {
    const { facetId } = facetIdParamsSchema.parse({ facetId: context.req.param('facetId') });
    deleteFacet(database, facetId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.delete('/api/sections/:sectionId', (context) => {
    const { groupId: sectionId } = tagGroupIdParamsSchema.parse({
      groupId: context.req.param('sectionId'),
    });
    deleteSection(database, sectionId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.post('/api/entries/:entryId/tags', async (context) => {
    const { entryId } = entryIdParamsSchema.parse(context.req.param());
    const input = await parseJson(context.req.raw, assignEntryTagRequestSchema);
    const assignment = assignEntryTag(database, { entryId, ...input });
    return context.json(entryTagAssignmentSchema.parse(assignment), 201);
  });

  app.get('/api/entries/:entryId/tags', (context) => {
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    return context.json(entryTagAssignmentSchema.array().parse(listEntryTags(database, entryId)));
  });

  app.patch('/api/entries/:entryId/tags/:tagId', async (context) => {
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const { tagId } = tagIdParamsSchema.parse({ tagId: context.req.param('tagId') });
    const input = await parseJson(context.req.raw, moveEntryTagRequestSchema);
    moveEntryTag(database, { entryId, tagId, targetFacetId: input.targetFacetId });
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.patch('/api/entries/:entryId/tags/:tagId/name', async (context) => {
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const { tagId } = tagIdParamsSchema.parse({ tagId: context.req.param('tagId') });
    const input = await parseJson(context.req.raw, renameEntryTagRequestSchema);
    const assignment = renameEntryTag(database, { entryId, tagId, name: input.name });
    return context.json(entryTagAssignmentSchema.parse(assignment));
  });

  app.delete('/api/entries/:entryId/tags/:tagId', (context) => {
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const { tagId } = tagIdParamsSchema.parse({ tagId: context.req.param('tagId') });
    removeEntryTag(database, entryId, tagId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.post('/api/entries/:entryId/contents', async (context) => {
    const { entryId } = entryIdParamsSchema.parse(context.req.param());
    const input = await parseJson(context.req.raw, createEntryContentRequestSchema);
    const content = createEntryContent(database, { entryId, ...input });
    return context.json(entryContentRecordSchema.parse(content), 201);
  });

  app.patch('/api/contents/:contentId', async (context) => {
    const { contentId } = contentIdParamsSchema.parse({ contentId: context.req.param('contentId') });
    const input = await parseJson(context.req.raw, updateEntryContentRequestSchema);
    return context.json(entryContentRecordSchema.parse(updateEntryContent(database, contentId, input)));
  });

  app.delete('/api/contents/:contentId', (context) => {
    const { contentId } = contentIdParamsSchema.parse({ contentId: context.req.param('contentId') });
    deleteEntryContent(database, contentId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.put('/api/entries/:entryId/contents/order', async (context) => {
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const input = await parseJson(context.req.raw, reorderEntryContentsRequestSchema);
    reorderEntryContents(database, entryId, input.orderedContentIds);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.post('/api/producers', async (context) => {
    const input = await parseJson(context.req.raw, createProducerRequestSchema);
    return context.json(producerRecordSchema.parse(createProducer(database, input)), 201);
  });

  app.get('/api/producers/:producerId', (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const detail = getAuthorDetail(database, producerId);
    if (!detail) throw new Error('producer not found');
    return context.json(authorDetailResponseSchema.parse(detail));
  });

  app.post('/api/producers/:producerId/directories', async (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const input = await parseJson(context.req.raw, createAuthorDirectoryRequestSchema);
    return context.json(authorDirectorySchema.parse(createAuthorDirectory(database, {
      producerId,
      ...input,
    })), 201);
  });

  app.patch('/api/author-directories/:directoryId', async (context) => {
    const { directoryId } = authorDirectoryIdParamsSchema.parse({
      directoryId: context.req.param('directoryId'),
    });
    const input = await parseJson(context.req.raw, updateAuthorDirectoryRequestSchema);
    return context.json(authorDirectorySchema.parse(
      updateAuthorDirectory(database, directoryId, input),
    ));
  });

  app.put('/api/producers/:producerId/directories/:directoryId/entries/:entryId', (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const { directoryId } = authorDirectoryIdParamsSchema.parse({
      directoryId: context.req.param('directoryId'),
    });
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    return context.json(authorDirectorySchema.parse(addEntryToAuthorDirectory(database, {
      producerId,
      directoryId,
      entryId,
    })));
  });

  app.delete('/api/producers/:producerId/directories/:directoryId/entries/:entryId', (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const { directoryId } = authorDirectoryIdParamsSchema.parse({
      directoryId: context.req.param('directoryId'),
    });
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    return context.json(authorDirectorySchema.parse(removeEntryFromAuthorDirectory(database, {
      producerId,
      directoryId,
      entryId,
    })));
  });

  app.patch('/api/producers/:producerId', async (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const input = await parseJson(context.req.raw, updateProducerRequestSchema);
    return context.json(producerRecordSchema.parse(updateProducer(database, producerId, input)));
  });

  app.delete('/api/producers/:producerId', (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    deleteProducer(database, producerId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.post('/api/producers/merge/plan', (context) => {
    const plans = planProducerMerges(database);
    return context.json(producerMergePlanResponseSchema.parse({ plans }));
  });

  app.post('/api/producers/merge', async (context) => {
    const emptyTotals = {
      deletedProducers: 0,
      worksRelinked: 0,
      tagsRelinked: 0,
      directoriesMoved: 0,
      directoriesMerged: 0,
      membershipsMoved: 0,
      membershipsRemoved: 0,
      renamed: 0,
    };
    const plans = planProducerMerges(database);
    if (plans.length === 0) {
      return context.json(producerMergeResponseSchema.parse({
        backupPath: null,
        plans: [],
        totals: emptyTotals,
        foreignKeyCheckPass: true,
        doctorPass: true,
        doctorIssues: [],
      }));
    }

    const backupPath = options.databasePath === undefined
      ? null
      : `${options.databasePath}.merge-backup-${new Date()
        .toISOString()
        .replace(/[-:]/gu, '')
        .replace(/\.\d{3}/u, '')}`;
    if (backupPath !== null) {
      await database.backup(backupPath);
    }

    database.pragma('foreign_keys = OFF');
    let executions: ReturnType<typeof executeProducerMerges> = [];
    try {
      executions = executeProducerMerges(database, plans);
    } finally {
      database.pragma('foreign_keys = ON');
    }

    const foreignKeyIssues = database.pragma('foreign_key_check') as unknown as unknown[];
    const doctor = inspectDatabase(database);
    const totals = executions.reduce((sum, execution) => ({
      deletedProducers: sum.deletedProducers + execution.deletedProducers,
      worksRelinked: sum.worksRelinked + execution.worksRelinked,
      tagsRelinked: sum.tagsRelinked + execution.tagsRelinked,
      directoriesMoved: sum.directoriesMoved + execution.directoriesMoved,
      directoriesMerged: sum.directoriesMerged + execution.directoriesMerged,
      membershipsMoved: sum.membershipsMoved + execution.membershipsMoved,
      membershipsRemoved: sum.membershipsRemoved + execution.membershipsRemoved,
      renamed: sum.renamed + (execution.renamedTo === null ? 0 : 1),
    }), emptyTotals);

    const executionItems = plans.map((plan, index) => {
      const execution = executions[index]!;
      return {
        displayName: plan.canonicalName ?? plan.keeper.name,
        canonicalName: plan.canonicalName,
        keeperId: plan.keeper.id,
        keeperName: execution.renamedTo ?? plan.keeper.name,
        absorbedProducers: plan.others.length,
        worksRelinked: execution.worksRelinked,
        tagsRelinked: execution.tagsRelinked,
        directoriesMoved: execution.directoriesMoved,
        directoriesMerged: execution.directoriesMerged,
        membershipsMoved: execution.membershipsMoved,
        membershipsRemoved: execution.membershipsRemoved,
        renamedFrom: execution.renamedTo === null ? null : plan.keeper.name,
        renamedTo: execution.renamedTo,
      };
    });

    return context.json(producerMergeResponseSchema.parse({
      backupPath,
      plans: executionItems,
      totals,
      foreignKeyCheckPass: foreignKeyIssues.length === 0,
      doctorPass: doctor.ok,
      doctorIssues: doctor.issues,
    }));
  });

  app.post('/api/entries/:entryId/template/apply', async (context) => {
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const entry = database.prepare('SELECT type FROM entries WHERE id = ?')
      .get(entryId) as { type: string } | undefined;
    if (!entry) {
      throw new Error('entry not found');
    }

    const backupPath = options.databasePath === undefined
      ? null
      : `${options.databasePath}.template-backup-${new Date()
        .toISOString()
        .replace(/[-:]/gu, '')
        .replace(/\.\d{3}/u, '')}`;
    if (backupPath !== null) {
      await database.backup(backupPath);
    }

    const result = applyLayoutTemplate(database, entryId);
    const foreignKeyIssues = database.pragma('foreign_key_check') as unknown as unknown[];
    const doctor = inspectDatabase(database);

    return context.json(layoutTemplateApplyResponseSchema.parse({
      ...result,
      backupPath,
      foreignKeyCheckPass: foreignKeyIssues.length === 0,
      doctorPass: doctor.ok,
      doctorIssues: doctor.issues,
    }));
  });

  app.post('/api/entries/:entryId/tag-layout/apply', async (context) => {
    const { entryId } = entryIdParamsSchema.parse({ entryId: context.req.param('entryId') });
    const entry = database.prepare('SELECT type FROM entries WHERE id = ?')
      .get(entryId) as { type: string } | undefined;
    if (!entry) {
      throw new Error('entry not found');
    }

    const backupPath = options.databasePath === undefined
      ? null
      : `${options.databasePath}.taglayout-backup-${new Date()
        .toISOString()
        .replace(/[-:]/gu, '')
        .replace(/\.\d{3}/u, '')}`;
    if (backupPath !== null) {
      await database.backup(backupPath);
    }

    const result = applyEntryTagLayout(database, entryId);
    const foreignKeyIssues = database.pragma('foreign_key_check') as unknown as unknown[];
    const doctor = inspectDatabase(database);

    return context.json(tagLayoutApplyResponseSchema.parse({
      ...result,
      backupPath,
      foreignKeyCheckPass: foreignKeyIssues.length === 0,
      doctorPass: doctor.ok,
      doctorIssues: doctor.issues,
    }));
  });

  app.put('/api/entries/:entryId/producers/:producerId', (context) => {
    const parameters = entryProducerParamsSchema.parse({
      entryId: context.req.param('entryId'),
      producerId: context.req.param('producerId'),
    });
    linkEntryProducer(database, parameters.entryId, parameters.producerId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.delete('/api/entries/:entryId/producers/:producerId', (context) => {
    const parameters = entryProducerParamsSchema.parse({
      entryId: context.req.param('entryId'),
      producerId: context.req.param('producerId'),
    });
    unlinkEntryProducer(database, parameters.entryId, parameters.producerId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.post('/api/producers/:producerId/tags', async (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const input = await parseJson(context.req.raw, assignProducerTagRequestSchema);
    const tag = assignProducerTag(database, { producerId, ...input });
    return context.json(producerTagAssignmentSchema.parse(tag), 201);
  });

  app.get('/api/producers/:producerId/tags', (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    return context.json(
      producerTagAssignmentSchema.array().parse(listProducerTags(database, producerId)),
    );
  });

  app.patch('/api/producers/:producerId/tags/:tagId/name', async (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const { tagId } = tagIdParamsSchema.parse({ tagId: context.req.param('tagId') });
    const input = await parseJson(context.req.raw, renameProducerTagRequestSchema);
    return context.json(producerTagAssignmentSchema.parse(renameProducerTag(database, {
      producerId,
      tagId,
      name: input.name,
    })));
  });

  app.delete('/api/producers/:producerId/tags/:tagId', (context) => {
    const { producerId } = producerIdParamsSchema.parse({
      producerId: context.req.param('producerId'),
    });
    const { tagId } = tagIdParamsSchema.parse({ tagId: context.req.param('tagId') });
    removeProducerTag(database, producerId, tagId);
    return context.json(mutationSuccessResponseSchema.parse({ ok: true }));
  });

  app.get('/api/producers', (context) => {
    const query = findProducersQuerySchema.parse(
      Object.fromEntries(new URL(context.req.url).searchParams),
    );
    return context.json(producerSummarySchema.array().parse(findProducers(database, query)));
  });

  if (options.staticRoot) {
    const staticMiddleware = serveStatic({ root: options.staticRoot });
    app.use('*', async (context, next) => {
      if (context.req.method === 'GET' && !context.req.path.startsWith('/api')) {
        return staticMiddleware(context, next);
      }
      return next();
    });
  }
  const spaIndexPath = options.staticRoot ? join(options.staticRoot, 'index.html') : undefined;

  app.notFound(async (context) => {
    if (spaIndexPath !== undefined
      && context.req.method === 'GET'
      && !context.req.path.startsWith('/api')) {
      try {
        const html = await readFile(spaIndexPath, 'utf8');
        return context.html(html);
      } catch {
        // Missing web build: fall through to the JSON 404 below.
      }
    }
    return context.json(errorPayload('NOT_FOUND', 'Route not found'), 404);
  });

  app.onError((error, context) => {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      const details = error instanceof ZodError ? error.issues : undefined;
      return context.json(errorPayload('VALIDATION_ERROR', 'Invalid request', details), 400);
    }
    if (error instanceof Error && error.message.includes('not found')) {
      return context.json(errorPayload('NOT_FOUND', error.message), 404);
    }
    if (isSqliteConstraintError(error) || isDomainConflictError(error)) {
      return context.json(errorPayload('CONFLICT', 'Request conflicts with current data'), 409);
    }
    return context.json(errorPayload('INTERNAL_ERROR', 'Internal server error'), 500);
  });

  return app;
}
