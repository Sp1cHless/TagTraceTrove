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
import { createFacet, createSection, listLayout } from '../../src/repositories/layout-repository.js';
import { commitImportBatch } from '../../src/import/commit.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { listTemplateSummaries, writeTemplateFiles } from '../../src/repositories/template-export.js';
import { COMMON_TEMPLATE, applyCommonTemplate } from '../../src/repositories/common-template.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('the common template (repository content, copied into a Gallery)', () => {
  it('gives a Gallery with no template one, as its own Sections and Facets', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);

    const result = applyCommonTemplate(database, 'novel');

    expect(result.sectionCount).toBe(COMMON_TEMPLATE.sections.length);
    expect(result.facetCount).toBe(
      COMMON_TEMPLATE.sections.reduce((total, section) => total + section.facets.length, 0));
    // The template's rating dimensions become this Gallery's own entry slots: a Gallery without one
    // cannot rate anything, and the template was built with a General Rating.
    expect(result.ratingSlotCount).toBe(COMMON_TEMPLATE.ratingSlots.length);
    const slots = database.prepare(
      "SELECT name FROM rating_slots WHERE subject_kind = 'entry' AND entry_type = ?",
    ).all('novel') as Array<{ name: string }>;
    expect(slots.map((slot) => slot.name)).toEqual(COMMON_TEMPLATE.ratingSlots);
    // The rows are the Gallery's own: that is what makes this "common" rather than "default" — the
    // editor can rename, empty or delete them like anything the person typed themselves.
    const layout = listLayout(database, 'novel');
    expect(layout.map((section) => section.name))
      .toEqual(COMMON_TEMPLATE.sections.map((section) => section.name));
    // Every real Section also carries the app's unnamed default Facet (name ''), which the UI hides.
    expect(layout.flatMap((section) => section.facets.map((facet) => facet.name))
      .filter((name) => name !== ''))
      .toEqual(COMMON_TEMPLATE.sections.flatMap((section) => section.facets));
    databases.at(-1)?.close();
  });

  it('refuses a Gallery that already has a template', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    createSection(database, { entryType: 'novel', name: '基本信息' });

    // Sections are the person's own decisions about their Gallery; adding three more to a structure
    // somebody built is how a template stops being theirs.
    expect(() => applyCommonTemplate(database, 'novel')).toThrow(/already has a template/);
  });
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

  it('refuses Gallery names containing path traversal before writing template files', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const dir = mkdtempSync(join(tmpdir(), 't3-template-escape-'));
    try {
      for (const unsafeType of ['../outside', '..\\outside']) {
        expect(() => writeTemplateFiles(database, unsafeType, dir)).toThrow(/entryType|Gallery|filename/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('carries the Gallery’s Content kinds in the template file and in the summary', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    createSection(database, { entryType: 'comic', name: 'Basic Information' });

    const first = createEntry(database, { title: 'First', type: 'comic' });
    createEntryContent(database, { entryId: first.id, contentType: 'description', content: 'A synopsis' });
    createEntryContent(database, { entryId: first.id, contentType: 'Source URL', content: 'https://x.test/1' });
    createEntryContent(database, { entryId: first.id, contentType: 'comment', content: 'Mine' });
    const second = createEntry(database, { title: 'Second', type: 'comic' });
    createEntryContent(database, { entryId: second.id, contentType: 'source url', content: 'https://x.test/2' });

    const dir = mkdtempSync(join(tmpdir(), 't3-content-kinds-'));
    try {
      const written = writeTemplateFiles(database, 'comic', dir);
      const file = JSON.parse(readFileSync(written.templatePath, 'utf8')) as {
        sections: unknown;
        contentKinds: string[];
      };
      // The two built-ins lead in their own order, and the spelling the works actually use wins
      // (`Source URL` on one work, `source url` on the other — the person's own words, not ours);
      // then every other kind the Gallery's works use, including one added on a single work.
      expect(file.contentKinds).toEqual(['Source URL', 'description', 'comment']);
      expect(file.sections).toBeDefined();
      // Advanced editing reads the same helper, so the view cannot disagree with the file it shows.
      const summary = listTemplateSummaries(database, dir).find((row) => row.entryType === 'comic');
      expect(summary?.contentKinds).toEqual(file.contentKinds);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a Gallery with no works the built-in Content kinds and writes no Content row', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    createSection(database, { entryType: 'novel', name: 'Basic Information' });

    const dir = mkdtempSync(join(tmpdir(), 't3-content-kinds-empty-'));
    try {
      const written = writeTemplateFiles(database, 'novel', dir);
      const file = JSON.parse(readFileSync(written.templatePath, 'utf8')) as { contentKinds: string[] };
      // `Source URL` and `description` come with every Gallery — nothing created them, and a work
      // shows a row only when it has text, so the kinds are a vocabulary rather than empty rows.
      expect(file.contentKinds).toEqual(['Source URL', 'description']);
      expect(database.prepare('SELECT COUNT(*) AS n FROM entry_contents').get()).toEqual({ n: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
