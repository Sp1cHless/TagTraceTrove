import type { T3Database } from './connection.js';

export interface DatabaseDoctorResult {
  ok: boolean;
  issues: string[];
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface TableColumn {
  name: string;
}

export function inspectDatabase(database: T3Database): DatabaseDoctorResult {
  const issues: string[] = [];
  if (database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number >= 31
    && !database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_feed_cursors'").get()) {
    issues.push('missing required table: sync_feed_cursors');
  }
  if (database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number >= 32
    && !database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_online_entry_creates'").get()) {
    issues.push('missing required table: sync_online_entry_creates');
  }
  if (database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number >= 33
    && !database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_offline_created_producers'").get()) {
    issues.push('missing required table: sync_offline_created_producers');
  }
  if (database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number >= 34) {
    for (const table of ['sync_offline_created_entry_facets', 'sync_offline_created_entry_tags', 'entry_tag_layouts', 'sync_entry_taxonomy_changes']) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) issues.push(`missing required table: ${table}`);
    }
  }
  if (database.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number >= 37
    && !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gallery_order_scope'").get()) {
    issues.push('missing required table: gallery_order_scope');
  }
  const integrityRows = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
  for (const row of integrityRows) {
    if (row.integrity_check !== 'ok') {
      issues.push(`integrity check: ${row.integrity_check}`);
    }
  }

  const foreignKeyRows = database.pragma('foreign_key_check') as ForeignKeyViolation[];
  for (const row of foreignKeyRows) {
    issues.push(
      `foreign key violation: ${row.table} row ${row.rowid ?? 'without rowid'} -> ${row.parent} (${row.fkid})`,
    );
  }

  const invalidFacets = database.prepare(`
    SELECT child.id
    FROM tag_groups AS child
    LEFT JOIN tag_groups AS parent ON parent.id = child.parent_id
    WHERE child.group_kind = 'facet'
      AND (
        parent.id IS NULL OR
        parent.group_kind <> 'section' OR
        parent.entry_type <> child.entry_type
      )
  `).pluck().all() as number[];
  for (const id of invalidFacets) {
    issues.push(`invalid facet hierarchy: tag_groups ${id}`);
  }

  const sectionsMissingDefaultFacet = database.prepare(`
    SELECT section.id
    FROM tag_groups AS section
    WHERE section.group_kind = 'section'
      AND NOT EXISTS (
        SELECT 1
        FROM tag_groups AS facet
        WHERE facet.parent_id = section.id
          AND facet.group_kind = 'facet'
          AND facet.name = ''
      )
  `).pluck().all() as number[];
  for (const id of sectionsMissingDefaultFacet) {
    issues.push(`missing default facet: section ${id}`);
  }

  const invalidAssignments = database.prepare(`
    SELECT assignment.entry_id || ':' || assignment.tag_id
    FROM entry_tags AS assignment
    JOIN entries AS entry ON entry.id = assignment.entry_id
    LEFT JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    WHERE facet.id IS NULL
       OR facet.group_kind <> 'facet'
       OR facet.entry_type <> entry.type
  `).pluck().all() as string[];
  for (const assignment of invalidAssignments) {
    issues.push(`invalid entry tag facet: ${assignment}`);
  }

  const invalidAuthorDirectoryEntries = database.prepare(`
    SELECT membership.directory_id || ':' || membership.entry_id
    FROM author_directory_entries AS membership
    LEFT JOIN author_directories AS directory
      ON directory.id = membership.directory_id
     AND directory.producer_id = membership.producer_id
    LEFT JOIN entry_producers AS relation
      ON relation.entry_id = membership.entry_id
     AND relation.producer_id = membership.producer_id
    WHERE directory.id IS NULL OR relation.entry_id IS NULL
  `).pluck().all() as string[];
  for (const membership of invalidAuthorDirectoryEntries) {
    issues.push(`invalid author directory membership: ${membership}`);
  }

  // A rating value must belong to a slot of its own subject kind; the plain
  // foreign keys only guarantee that the slot row exists.
  const invalidEntryRatings = database.prepare(`
    SELECT value.entry_id || ':' || value.slot_id
    FROM entry_rating_values AS value
    LEFT JOIN rating_slots AS slot ON slot.id = value.slot_id
      AND slot.subject_kind = 'entry'
    WHERE slot.id IS NULL
  `).pluck().all() as string[];
  for (const rating of invalidEntryRatings) {
    issues.push(`invalid entry rating slot: ${rating}`);
  }

  // An author's value may belong to either of their two classes — the works summary ('producer') or
  // the author themselves ('author_self') — and to nothing else: neither an Entry's slot nor a slot
  // of a Gallery the author is not anchored to.
  const invalidProducerRatings = database.prepare(`
    SELECT value.producer_id || ':' || value.slot_id
    FROM producer_rating_values AS value
    LEFT JOIN rating_slots AS slot ON slot.id = value.slot_id
      AND slot.subject_kind IN ('producer', 'author_self')
    WHERE slot.id IS NULL
  `).pluck().all() as string[];
  for (const rating of invalidProducerRatings) {
    issues.push(`invalid producer rating slot: ${rating}`);
  }

  // Collections nest at most one level: a child folder can never be a parent.
  const nestedTooDeep = database.prepare(`
    SELECT child.id
    FROM collections AS child
    JOIN collections AS parent ON parent.id = child.parent_id
    WHERE parent.parent_id IS NOT NULL
  `).pluck().all() as number[];
  for (const id of nestedTooDeep) {
    issues.push(`collection nested too deep: collections ${id}`);
  }

  // Each member table must hang off a collection of its own kind.
  const invalidEntryMembers = database.prepare(`
    SELECT link.collection_id || ':' || link.entry_id
    FROM collection_entries AS link
    JOIN collections AS collection ON collection.id = link.collection_id
    WHERE collection.kind <> 'entry'
  `).pluck().all() as string[];
  for (const member of invalidEntryMembers) {
    issues.push(`invalid collection entry member: ${member}`);
  }

  const invalidProducerMembers = database.prepare(`
    SELECT link.collection_id || ':' || link.producer_id
    FROM collection_producers AS link
    JOIN collections AS collection ON collection.id = link.collection_id
    WHERE collection.kind <> 'producer'
  `).pluck().all() as string[];
  for (const member of invalidProducerMembers) {
    issues.push(`invalid collection producer member: ${member}`);
  }

  // A folder's Gallery page is a scope name, never a foreign key: a scope whose
  // Entry type no longer exists would leave the folder unreachable.
  const collectionColumns = new Set(
    (database.pragma('table_info(collections)') as TableColumn[]).map((column) => column.name),
  );
  if (collectionColumns.has('gallery_type')) {
    const orphanedGalleryScopes = database.prepare(`
      SELECT collection.id || ':' || collection.gallery_type
      FROM collections AS collection
      WHERE collection.gallery_type IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM entries WHERE entries.type = collection.gallery_type)
    `).pluck().all() as string[];
    for (const scope of orphanedGalleryScopes) {
      issues.push(`collection Gallery scope without a Gallery: ${scope}`);
    }
  }

  const entriesColumns = new Set(
    (database.pragma('table_info(entries)') as TableColumn[]).map((column) => column.name),
  );
  const contentColumns = new Set(
    (database.pragma('table_info(entry_contents)') as TableColumn[]).map((column) => column.name),
  );
  const producerColumns = new Set(
    (database.pragma('table_info(producers)') as TableColumn[]).map((column) => column.name),
  );
  const producerTagColumns = new Set(
    (database.pragma('table_info(producer_tags)') as TableColumn[]).map((column) => column.name),
  );
  const authorDirectoryColumns = new Set(
    (database.pragma('table_info(author_directories)') as TableColumn[]).map((column) => column.name),
  );
  const authorDirectorySetColumns = new Set(
    (database.pragma('table_info(author_directory_sets)') as TableColumn[]).map((column) => column.name),
  );
  const ratingLayoutColumns = new Set(
    (database.pragma('table_info(rating_slot_layouts)') as TableColumn[]).map((column) => column.name),
  );
  if (entriesColumns.has('sync_uid')) {
    const missingEntrySyncIds = database.prepare(`
      SELECT id FROM entries
      WHERE sync_uid IS NULL OR trim(sync_uid) = '' OR sync_version < 1
      ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingEntrySyncIds) {
      issues.push(`missing sync identity: entries ${id}`);
    }
  }
  if (contentColumns.has('sync_uid')) {
    const missingContentSyncIds = database.prepare(`
      SELECT id FROM entry_contents
      WHERE sync_uid IS NULL OR trim(sync_uid) = '' OR sync_version < 1
      ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingContentSyncIds) {
      issues.push(`missing sync identity: entry_contents ${id}`);
    }
  }
  if (producerColumns.has('sync_uid')) {
    const missingProducerSyncIds = database.prepare(`
      SELECT id FROM producers
      WHERE sync_uid IS NULL OR trim(sync_uid) = '' OR sync_version < 1
      ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingProducerSyncIds) {
      issues.push(`missing sync identity: producers ${id}`);
    }
  }
  if (producerTagColumns.has('sync_uid')) {
    const missingTagSyncIds = database.prepare(`
      SELECT id FROM producer_tags
      WHERE sync_uid IS NULL OR trim(sync_uid) = ''
      ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingTagSyncIds) {
      issues.push(`missing sync identity: producer_tags ${id}`);
    }
  }

  if (collectionColumns.has('sync_uid')) {
    const missingCollectionSyncIds = database.prepare(`
      SELECT id FROM collections
      WHERE sync_uid IS NULL OR trim(sync_uid) = '' OR sync_version < 1 ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingCollectionSyncIds) issues.push(`missing sync identity: collections ${id}`);
  }
  if (authorDirectoryColumns.has('sync_uid')) {
    const missingDirectorySyncIds = database.prepare(`
      SELECT id FROM author_directories WHERE sync_uid IS NULL OR trim(sync_uid) = '' ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingDirectorySyncIds) issues.push(`missing sync identity: author_directories ${id}`);
  }
  if (authorDirectorySetColumns.has('sync_uid')) {
    const missingDirectorySetSyncIds = database.prepare(`
      SELECT id FROM author_directory_sets WHERE sync_uid IS NULL OR trim(sync_uid) = '' OR sync_version < 1 ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingDirectorySetSyncIds) issues.push(`missing sync identity: author_directory_sets ${id}`);
    const producersMissingDirectorySets = database.prepare(`
      SELECT producer.id FROM producers AS producer
      LEFT JOIN author_directory_sets AS directory_set ON directory_set.producer_id = producer.id
      WHERE directory_set.id IS NULL ORDER BY producer.id
    `).pluck().all() as number[];
    for (const id of producersMissingDirectorySets) issues.push(`missing Author Directory set: producer ${id}`);
  }
  if (ratingLayoutColumns.has('sync_uid')) {
    const missingLayoutSyncIds = database.prepare(`
      SELECT id FROM rating_slot_layouts WHERE sync_uid IS NULL OR trim(sync_uid) = '' OR sync_version < 1
      ORDER BY id
    `).pluck().all() as number[];
    for (const id of missingLayoutSyncIds) issues.push(`missing sync identity: rating_slot_layouts ${id}`);
    const layoutsMissingPartitions = database.prepare(`
      SELECT layouts.subject_kind || ':' || layouts.entry_type
      FROM (
        SELECT 'entry' AS subject_kind, type AS entry_type FROM entries GROUP BY type
        UNION
        SELECT 'producer' AS subject_kind, type AS entry_type FROM entries GROUP BY type
        UNION
        SELECT subject_kind, entry_type FROM rating_slots GROUP BY subject_kind, entry_type
      ) AS layouts
      WHERE NOT EXISTS (
        SELECT 1 FROM rating_slot_layouts AS resource
        WHERE resource.subject_kind = layouts.subject_kind AND resource.entry_type = layouts.entry_type
      )
    `).pluck().all() as string[];
    for (const partition of layoutsMissingPartitions) issues.push(`missing rating layout identity: ${partition}`);
  }

  const requiredIndexes = ['idx_entries_page_date', 'idx_entries_page_title'];
  if (entriesColumns.has('sync_uid')) requiredIndexes.push('uq_entries_sync_uid');
  if (contentColumns.has('sync_uid')) requiredIndexes.push('uq_entry_contents_sync_uid');
  if (producerColumns.has('sync_uid')) requiredIndexes.push('uq_producers_sync_uid');
  if (producerTagColumns.has('sync_uid')) requiredIndexes.push('uq_producer_tags_sync_uid');
  if (collectionColumns.has('sync_uid')) requiredIndexes.push('uq_collections_sync_uid');
  if (authorDirectoryColumns.has('sync_uid')) requiredIndexes.push('uq_author_directories_sync_uid');
  if (authorDirectorySetColumns.has('sync_uid')) {
    requiredIndexes.push('uq_author_directory_sets_producer_id', 'uq_author_directory_sets_sync_uid');
  }
  if (ratingLayoutColumns.has('sync_uid')) {
    requiredIndexes.push('uq_rating_slot_layouts_sync_uid', 'uq_rating_slot_layouts_partition');
  }
  const presentIndexes = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index'
  `).pluck().all() as string[]);
  for (const index of requiredIndexes) {
    if (!presentIndexes.has(index)) issues.push(`missing required index: ${index}`);
  }

  const syncTriggers = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger'
  `).pluck().all() as string[]);
  const hasMigrationLedger = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
  `).get() !== undefined;
  const currentSchemaVersion = hasMigrationLedger
    ? database.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').pluck().get() as number
    : 0;
  if (producerColumns.has('sync_uid') && currentSchemaVersion >= 26) {
    for (const trigger of [
      'producer_rating_values_sync_insert',
      'producer_rating_values_sync_update',
      'producer_rating_values_sync_delete',
    ]) {
      if (!syncTriggers.has(trigger)) issues.push(`missing required trigger: ${trigger}`);
    }
  }
  if (producerTagColumns.has('sync_uid') && currentSchemaVersion >= 27) {
    for (const trigger of [
      'producer_tags_sync_identity_insert',
      'producer_tags_sync_uid_immutable',
      'producer_tags_sync_update',
      'producer_tag_assignments_sync_insert',
      'producer_tag_assignments_sync_update',
      'producer_tag_assignments_sync_delete',
    ]) {
      if (!syncTriggers.has(trigger)) issues.push(`missing required trigger: ${trigger}`);
    }
  }
  if (currentSchemaVersion >= 28) {
    for (const trigger of [
      'collections_sync_insert', 'collections_sync_update', 'collections_sync_delete',
      'collections_sync_revision', 'collections_sync_uid_immutable',
      'collection_entries_sync_insert', 'collection_entries_sync_delete',
      'collection_producers_sync_insert', 'collection_producers_sync_delete',
      'author_directories_sync_insert', 'author_directories_sync_update',
      'author_directories_sync_delete', 'author_directories_sync_uid_immutable',
      'author_directory_sets_sync_update', 'author_directory_sets_sync_delete',
      'author_directory_sets_sync_uid_immutable', 'producers_directory_set_insert',
      'author_directory_entries_sync_insert', 'author_directory_entries_sync_delete',
      'author_directory_entries_sync_update', 'rating_slot_layouts_sync_update', 'rating_slot_layouts_sync_delete',
      'rating_slot_layouts_sync_identity_immutable', 'rating_slots_ensure_layout_before_insert',
      'rating_slots_layout_insert', 'rating_slots_layout_update', 'rating_slots_layout_delete',
      'entries_rating_layout_insert', 'entries_rating_layout_type_update',
    ]) {
      if (!syncTriggers.has(trigger)) issues.push(`missing required trigger: ${trigger}`);
    }
  }

  if (currentSchemaVersion >= 29) {
    for (const trigger of ['entry_producers_sync_insert', 'entry_producers_sync_delete']) {
      if (!syncTriggers.has(trigger)) issues.push(`missing required trigger: ${trigger}`);
    }
  }
  if (currentSchemaVersion >= 30) {
    for (const trigger of ['entry_tags_sync_insert', 'entry_tags_sync_delete', 'entry_tags_sync_update']) {
      if (!syncTriggers.has(trigger)) issues.push(`missing required trigger: ${trigger}`);
    }
  }
  if (currentSchemaVersion >= 42) {
    if (!producerColumns.has('directory_set_seed_uid')) issues.push('missing required column: producers.directory_set_seed_uid');
    for (const trigger of ['producers_directory_seed_immutable','author_directory_sets_sync_insert']) if (!syncTriggers.has(trigger)) issues.push(`missing required trigger: ${trigger}`);
    if (producerColumns.has('directory_set_seed_uid') && database.prepare(`SELECT 1 FROM producers p LEFT JOIN author_directory_sets s ON s.producer_id=p.id WHERE p.directory_set_seed_uid IS NOT NULL AND (s.sync_uid IS NULL OR s.sync_uid<>p.directory_set_seed_uid COLLATE NOCASE) LIMIT 1`).get()) issues.push('Directory seed binding mismatch');
  }
  return { ok: issues.length === 0, issues };
}
