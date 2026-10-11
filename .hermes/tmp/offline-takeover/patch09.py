import io

path = r'D:\Project\TagTraceTrove\apps\server\src\sync\replay-service.ts'
text = io.open(path, encoding='utf-8').read()

anchor = "    if (operation.operationKind === 'entry.delete') {"
add = """    if (operation.operationKind === 'entry.tag-layout.apply') {
      const entry = database.prepare('SELECT id, type, sync_version AS version FROM entries WHERE sync_uid = ? COLLATE NOCASE')
        .get(operation.entityUid) as { id: number; type: string; version: number } | undefined;
      if (!entry) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Source Entry no longer exists',
      });
      if (entry.version !== operation.baseVersion) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'conflict', currentVersion: entry.version, currentValues: {}, serverSeq: maxServerSeq(database),
      });
      const canonical = (rows: Array<{ tagUid: string; facetUid: string }>) => rows
        .map(row => ({ tagUid: row.tagUid.toLowerCase(), facetUid: row.facetUid.toLowerCase() }))
        .sort((a, b) => a.tagUid.localeCompare(b.tagUid));
      const current = canonical(database.prepare(`
        SELECT t.sync_uid AS "tagUid", g.sync_uid AS "facetUid" FROM entry_tags et
        JOIN tags t ON t.id = et.tag_id JOIN tag_groups g ON g.id = et.facet_id
        WHERE et.entry_id = ?`).all(entry.id) as Array<{ tagUid: string; facetUid: string }>);
      if (JSON.stringify(current) !== JSON.stringify(canonical([...operation.baseValues.assignments]))) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: entry.version, currentValues: {}, serverSeq: maxServerSeq(database),
        });
      }
      const result = applyEntryTagLayout(database, entry.id);
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: entry.id,
        resourceVersion: Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)),
        serverSeq: maxServerSeq(database),
        tagLayoutApply: { entryType: result.entryType, entriesAffected: result.entriesAffected, tagsMoved: result.tagsMoved, entriesScanned: result.entriesScanned },
      });
    }

    if (operation.operationKind === 'entry.layout-template.apply') {
      const layout = database.prepare('SELECT entry_type AS entryType, sync_version AS version FROM entry_tag_layouts WHERE sync_uid = ?')
        .get(operation.entityUid) as { entryType: string; version: number } | undefined;
      if (!layout) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Tag layout no longer exists',
      });
      if (layout.version !== operation.baseVersion) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'conflict', currentVersion: layout.version, currentValues: {}, serverSeq: maxServerSeq(database),
      });
      const canonicalize = (rows: Array<{ syncUid: string; name: string; groupKind: 'section' | 'facet'; parentUid: string | null; sortOrder: number }>) => rows
        .map(row => ({ ...row, syncUid: row.syncUid.toLowerCase(), parentUid: row.parentUid === null ? null : row.parentUid.toLowerCase() }))
        .sort((a, b) => a.syncUid.localeCompare(b.syncUid));
      const current = canonicalize(database.prepare(`SELECT g.sync_uid AS syncUid, g.name, g.group_kind AS groupKind, p.sync_uid AS parentUid, g.sort_order AS sortOrder
        FROM tag_groups g LEFT JOIN tag_groups p ON p.id = g.parent_id WHERE g.entry_type = ?`).all(layout.entryType) as Array<{ syncUid: string; name: string; groupKind: 'section' | 'facet'; parentUid: string | null; sortOrder: number }>);
      if (!valuesMatch(canonicalize([...operation.baseValues.groups]), current)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: layout.version, currentValues: {}, serverSeq: maxServerSeq(database),
        });
      }
      // Mirror applyLayoutTemplate: rename old sections aside for the unique
      // name index, insert the desired rows under their frozen client UUIDs,
      // relink every assignment by (section, facet) name key BEFORE the old
      // rows go (entry_tags.facet_id is ON DELETE RESTRICT), then delete old
      // facets and sections explicitly so every DML journals.
      const normalizeName = (name: string) => name.normalize('NFKC').trim().replace(/\\s+/gu, ' ').toLowerCase();
      const oldSections = current.filter(row => row.groupKind === 'section');
      oldSections.forEach((row, index) => {
        database.prepare('UPDATE tag_groups SET name = ? WHERE sync_uid = ?').run(`__t3_template_${index}__`, row.syncUid);
      });
      const insertSection = database.prepare("INSERT INTO tag_groups (entry_type, name, group_kind, sort_order, sync_uid) VALUES (?, ?, 'section', ?, ?)");
      const insertFacet = database.prepare("INSERT INTO tag_groups (entry_type, name, group_kind, parent_id, sort_order, sync_uid) VALUES (?, ?, 'facet', ?, ?, ?)");
      const desiredSections = operation.payload.groups.filter(row => row.groupKind === 'section');
      const newFacetIds = new Map<string, string>();
      let fallbackUid: string | undefined;
      for (const section of desiredSections) {
        const sectionId = Number(insertSection.run(layout.entryType, section.name, section.sortOrder, section.syncUid).lastInsertRowid);
        const sectionKey = normalizeName(section.name);
        for (const facet of operation.payload.groups.filter(row => row.groupKind === 'facet' && row.parentUid?.toLowerCase() === section.syncUid.toLowerCase())) {
          insertFacet.run(layout.entryType, facet.name, sectionId, facet.sortOrder, facet.syncUid);
          const key = facet.name === '' ? (sectionKey + '\\u0000') : (sectionKey + '\\u0000' + normalizeName(facet.name));
          if (!newFacetIds.has(key)) newFacetIds.set(key, facet.syncUid.toLowerCase());
          if (facet.name === '' && fallbackUid === undefined) fallbackUid = facet.syncUid.toLowerCase();
        }
      }
      if (fallbackUid === undefined) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data', detail: 'Template layout has no default facet to receive tags',
      });
      const facetIdOf = database.prepare('SELECT id FROM tag_groups WHERE sync_uid = ?');
      const fallbackId = facetIdOf.pluck().get(fallbackUid) as number | undefined;
      if (fallbackId === undefined) throw new Error('Rebuilt facet identity missing');
      for (const old of current.filter(row => row.groupKind === 'facet')) {
        const oldId = facetIdOf.pluck().get(old.syncUid) as number | undefined;
        if (oldId === undefined) continue;
        const oldSection = current.find(row => row.groupKind === 'section' && row.syncUid === old.parentUid);
        const key = oldSection === undefined ? ('\\u0000' + normalizeName(old.name))
          : old.name === '' ? (normalizeName(oldSection.name) + '\\u0000')
          : (normalizeName(oldSection.name) + '\\u0000' + normalizeName(old.name));
        const targetUid = newFacetIds.get(key) ?? fallbackUid;
        const targetId = facetIdOf.pluck().get(targetUid) as number | undefined;
        if (targetId === undefined) continue;
        if (targetId !== oldId) database.prepare('UPDATE entry_tags SET facet_id = ? WHERE facet_id = ?').run(targetId, oldId);
      }
      for (const row of [...current].reverse()) {
        database.prepare('DELETE FROM tag_groups WHERE sync_uid = ?').run(row.syncUid);
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied',
        resourceVersion: Number(database.prepare('SELECT sync_version FROM entry_tag_layouts WHERE sync_uid = ?').pluck().get(operation.entityUid)),
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'entry.delete') {"""
assert anchor in text, 'anchor missing'
text = text.replace(anchor, add, 1)
text = text.replace(
    "import { mergeAuthorEntries } from '../repositories/entry-merge-repository.js';",
    "import { mergeAuthorEntries } from '../repositories/entry-merge-repository.js';\n"
    "import { applyEntryTagLayout } from '../repositories/entry-tag-repository.js';", 1)
io.open(path, 'w', encoding='utf-8', newline='').write(text)
print('server branches added')
