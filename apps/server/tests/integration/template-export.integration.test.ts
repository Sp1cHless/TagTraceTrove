import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import {
  assignEntryTag,
  findEntriesByFacetFilters,
} from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { commitImportBatch } from '../../src/import/commit.js';
import { listTemplateSummaries, writeTemplateFiles } from '../../src/repositories/template-export.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('formal gallery templates (real SQL + files)', () => {
  it('places imported tags onto the majority facet of the saved tag layout', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
    const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
    const tagsSection = createSection(database, { entryType: 'comic', name: 'Tags' });

    // Existing entry establishes the layout: 'Azur Lane' lives under Series.
    const existing = createEntry(database, { title: 'Existing Work', type: 'comic' });
    assignEntryTag(database, { entryId: existing.id, facetId: series.id, name: 'Azur Lane' });

    // Import a batch carrying the same tag plus an unseen one.
    const result = commitImportBatch(database, {
      source: 'probe.example',
      warnings: [],
      entries: [{
        externalKey: 'probe.example:1',
        title: 'Imported Work',
        tags: [{ name: 'Azur Lane' }, { name: 'Fresh Tag' }],
        sources: [{ url: 'https://probe.example/1' }],
      }],
    }, {
      entryType: 'comic',
      canonicalTagFacetId: tagsSection.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: {},
      ignoredFields: [],
      authorRatings: [],
    });
    const importedId = result.entries[0]!.entryId;

    // 'Azur Lane' followed the saved layout instead of the default position.
    expect(findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: series.id, tagIds: [] }],
      authorIds: [],
    }).some((entry) => entry.id === importedId)).toBe(true);
    const placement = database.prepare(`
      SELECT facet.name AS facet_name
      FROM entry_tags AS assignment
      JOIN tags AS tag ON tag.id = assignment.tag_id
      JOIN tag_groups AS facet ON facet.id = assignment.facet_id
      JOIN entries AS entry ON entry.id = assignment.entry_id
      WHERE entry.id = ? AND tag.normalized_name = 'azur lane'
    `).get(importedId) as { facet_name: string };
    expect(placement.facet_name).toBe('Series');
    // The unseen tag still lands on the reviewed canonical position.
    const freshPlacement = database.prepare(`
      SELECT facet.name AS facet_name
      FROM entry_tags AS assignment
      JOIN tags AS tag ON tag.id = assignment.tag_id
      JOIN tag_groups AS facet ON facet.id = assignment.facet_id
      WHERE assignment.entry_id = ? AND tag.normalized_name = 'fresh tag'
    `).get(importedId) as { facet_name: string };
    expect(freshPlacement.facet_name).toBe('');
  });

  it('writes formal template files and lists summaries', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
    const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
    const work = createEntry(database, { title: 'Work', type: 'comic' });
    assignEntryTag(database, { entryId: work.id, facetId: series.id, name: 'Azur Lane' });

    const dir = mkdtempSync(join(tmpdir(), 't3-templates-'));
    try {
      const written = writeTemplateFiles(database, 'comic', dir);
      expect(written.mappingCount).toBe(1);
      expect(existsSync(written.templatePath)).toBe(true);
      expect(existsSync(written.tagLayoutPath)).toBe(true);

      const layoutFile = JSON.parse(readFileSync(written.tagLayoutPath, 'utf8')) as {
        entryType: string;
        mappings: Array<{ tag: string; section: string; facet: string }>;
      };
      expect(layoutFile.entryType).toBe('comic');
      expect(layoutFile.mappings).toEqual([
        { tag: 'Azur Lane', section: 'Basic Information', facet: 'Series' },
      ]);

      const summaries = listTemplateSummaries(database, dir);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.entryType).toBe('comic');
      // Facet order mirrors the layout; the unnamed default shows as ''.
      expect(summaries[0]!.sections[0]?.name).toBe('Basic Information');
      expect(new Set(summaries[0]!.sections[0]!.facets)).toEqual(new Set(['Series', '']));
      expect(summaries[0]!.templatePath).toBe(written.templatePath);
      expect(summaries[0]!.tagLayoutPath).toBe(written.tagLayoutPath);
      expect(summaries[0]!.tagLayoutExists).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
