import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryDatabase } from '../../src/database/testing.js';

const migrationPath = fileURLToPath(
  new URL('../../src/database/migrations/001_initial.sql', import.meta.url),
);
const migrationSql = readFileSync(migrationPath, 'utf8');

function createMigratedDatabase() {
  const database = createMemoryDatabase();
  database.exec(migrationSql);
  return database;
}

describe('initial schema migration', () => {
  it('applies to SQLite and creates the core tables', () => {
    const database = createMemoryDatabase();

    try {
      expect(() => database.exec(migrationSql)).not.toThrow();

      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => (row as { name: string }).name)
        .sort();

      expect(tables).toEqual([
        'entries',
        'entry_contents',
        'entry_producers',
        'entry_tags',
        'producer_tag_assignments',
        'producer_tags',
        'producers',
        'tag_groups',
        'tags',
      ]);
    } finally {
      database.close();
    }
  });

  it('requires every facet to belong to a section of the same entry type', () => {
    const database = createMigratedDatabase();

    try {
      database.prepare(
        "INSERT INTO tag_groups (id, entry_type, name, group_kind) VALUES (1, 'game', 'Basic', 'section')",
      ).run();
      database.prepare(
        "INSERT INTO tag_groups (id, entry_type, name, group_kind, parent_id) VALUES (2, 'game', '', 'facet', 1)",
      ).run();

      expect(() => database.prepare(
        "INSERT INTO tag_groups (entry_type, name, group_kind, parent_id) VALUES ('game', 'Nested', 'facet', 2)",
      ).run()).toThrow('facet parent must be a section of the same entry type');
      expect(() => database.prepare(
        "INSERT INTO tag_groups (entry_type, name, group_kind, parent_id) VALUES ('manga', 'Wrong type', 'facet', 1)",
      ).run()).toThrow('facet parent must be a section of the same entry type');
    } finally {
      database.close();
    }
  });

  it('stores entry tags only in facets of the matching entry type', () => {
    const database = createMigratedDatabase();

    try {
      database.exec(`
        INSERT INTO entries (id, title, type) VALUES (1, 'Example', 'game');
        INSERT INTO tags (id, name, normalized_name) VALUES (1, 'Character', 'character');
        INSERT INTO tag_groups (id, entry_type, name, group_kind) VALUES
          (1, 'game', 'Basic', 'section'),
          (2, 'game', 'Review', 'section'),
          (3, 'manga', 'Basic', 'section');
        INSERT INTO tag_groups (id, entry_type, name, group_kind, parent_id) VALUES
          (4, 'game', '', 'facet', 1),
          (5, 'game', 'Opinion', 'facet', 2),
          (6, 'manga', '', 'facet', 3);
      `);

      expect(() => database.prepare(
        'INSERT INTO entry_tags (entry_id, tag_id, facet_id) VALUES (1, 1, 1)',
      ).run()).toThrow('entry tag must target a facet of the entry type');
      expect(() => database.prepare(
        'INSERT INTO entry_tags (entry_id, tag_id, facet_id) VALUES (1, 1, 6)',
      ).run()).toThrow('entry tag must target a facet of the entry type');

      database.prepare(
        'INSERT INTO entry_tags (entry_id, tag_id, facet_id) VALUES (1, 1, 4)',
      ).run();
      database.prepare(
        'UPDATE entry_tags SET facet_id = 5 WHERE entry_id = 1 AND tag_id = 1',
      ).run();

      expect(database.prepare(
        'SELECT facet_id FROM entry_tags WHERE entry_id = 1 AND tag_id = 1',
      ).pluck().get()).toBe(5);
    } finally {
      database.close();
    }
  });

  it('keeps producer tags separate and producer content simple', () => {
    const database = createMigratedDatabase();

    try {
      database.exec(`
        INSERT INTO producers (id, name, content) VALUES (1, 'Creator', 'Short review');
        INSERT INTO tags (id, name, normalized_name) VALUES (1, 'Favorite', 'favorite');
        INSERT INTO producer_tags (id, name, normalized_name) VALUES (1, 'Favorite', 'favorite');
        INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (1, 1);
      `);

      expect(database.prepare('SELECT content FROM producers WHERE id = 1').pluck().get())
        .toBe('Short review');
      expect(database.prepare('SELECT COUNT(*) FROM producer_tag_assignments').pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('accepts arbitrary entry content type labels', () => {
    const database = createMigratedDatabase();

    try {
      database.exec("INSERT INTO entries (id, title, type) VALUES (1, 'Example', 'game')");
      database.prepare(
        'INSERT INTO entry_contents (entry_id, content_type, content) VALUES (?, ?, ?)',
      ).run(1, 'custom/source label', 'https://example.test/item');

      expect(database.prepare(
        'SELECT content_type FROM entry_contents WHERE entry_id = 1',
      ).pluck().get()).toBe('custom/source label');
    } finally {
      database.close();
    }
  });
});
