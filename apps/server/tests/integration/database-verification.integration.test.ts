import { describe, expect, it } from 'vitest';
import { inspectDatabase } from '../../src/database/doctor.js';
import { runDatabaseProbe } from '../../src/database/probe.js';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';

describe('database verification', () => {
  it('reports a clean migrated database', () => {
    const database = createMigratedMemoryDatabase();

    try {
      expect(inspectDatabase(database)).toEqual({ ok: true, issues: [] });
    } finally {
      database.close();
    }
  });

  it('reports a missing performance-critical Entry paging index', () => {
    const database = createMigratedMemoryDatabase();
    try {
      database.exec('DROP INDEX idx_entries_page_date');
      expect(inspectDatabase(database).issues).toContain(
        'missing required index: idx_entries_page_date',
      );
    } finally {
      database.close();
    }
  });

  it('reports foreign-key corruption without modifying it', () => {
    const database = createMigratedMemoryDatabase();

    try {
      database.pragma('foreign_keys = OFF');
      database.prepare(
        'INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (999, 999)',
      ).run();
      database.pragma('foreign_keys = ON');

      const result = inspectDatabase(database);
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.startsWith('foreign key violation:'))).toBe(true);
    } finally {
      database.close();
    }
  });

  it('reports a section that is missing its unnamed default facet', () => {
    const database = createMigratedMemoryDatabase();

    try {
      database.prepare(`
        INSERT INTO tag_groups (entry_type, name, group_kind)
        VALUES ('game', 'Basic', 'section')
      `).run();

      expect(inspectDatabase(database).issues).toContain(
        'missing default facet: section 1',
      );
    } finally {
      database.close();
    }
  });

  it('reports rating slots, nesting depth, and collection-kind violations', () => {
    const database = createMigratedMemoryDatabase();

    try {
      // A producer rating value pointed at an 'entry' slot: the FK holds but
      // the subject kinds do not match.
      const slot = database.prepare(`
        INSERT INTO rating_slots (subject_kind, entry_type, name, sort_order)
        VALUES ('entry', 'game', 'Quality', 0)
      `).run();
      database.pragma('foreign_keys = OFF');
      database.prepare(
        'INSERT INTO producer_rating_values (producer_id, slot_id, stars) VALUES (1, ?, 4)',
      ).run(slot.lastInsertRowid);
      // A child folder that is itself a parent — more than one nesting level.
      const parent = database.prepare(`
        INSERT INTO collections (kind, title) VALUES ('entry', 'Parent')
      `).run();
      const child = database.prepare(`
        INSERT INTO collections (kind, title, parent_id) VALUES ('entry', 'Child', ?)
      `).run(parent.lastInsertRowid);
      database.prepare(`
        INSERT INTO collections (kind, title, parent_id) VALUES ('entry', 'Grandchild', ?)
      `).run(child.lastInsertRowid);
      // An entry member hanging off a producer collection.
      const authors = database.prepare(`
        INSERT INTO collections (kind, title) VALUES ('producer', 'Authors')
      `).run();
      database.prepare(
        'INSERT INTO collection_entries (collection_id, entry_id) VALUES (?, 1)',
      ).run(authors.lastInsertRowid);
      database.pragma('foreign_keys = ON');

      const issues = inspectDatabase(database).issues;
      expect(issues.some((issue) => issue.startsWith('invalid producer rating slot:'))).toBe(true);
      expect(issues.some((issue) => issue.startsWith('collection nested too deep:'))).toBe(true);
      expect(issues.some((issue) => issue.startsWith('invalid collection entry member:'))).toBe(true);
    } finally {
      database.close();
    }
  });

  it('proves the core entry, producer, facet, tag, and content paths', () => {
    const result = runDatabaseProbe();

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.checks.map((check) => check.name)).toContain('persist shared View later');
  });
});
