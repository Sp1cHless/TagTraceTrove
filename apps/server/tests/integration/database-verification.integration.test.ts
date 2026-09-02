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

  it('proves the core entry, producer, facet, tag, and content paths', () => {
    const result = runDatabaseProbe();

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });
});
