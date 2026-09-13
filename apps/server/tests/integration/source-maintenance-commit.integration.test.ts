import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
import type { T3Database } from '../../src/database/connection.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { listEntrySources } from '../../src/repositories/source-library-repository.js';
import {
  createRun,
  getRun,
  patchItem,
  setSourceStatus,
  updateRunStatus,
  upsertItem,
} from '../../src/source-maintenance/repository.js';
import {
  commitSourceMaintenanceRun,
  CommitConflictError,
  CommitStaleError,
} from '../../src/source-maintenance/commit-service.js';

const TARGET_ORIGIN = 'https://fake.test';

interface Fixture {
  database: T3Database;
  databasePath: string;
  entryIds: Record<string, number>;
  runId: number;
  cleanup: () => void;
}

function entryIdOf(fixture: Fixture, key: string): number {
  const id = fixture.entryIds[key];
  if (id === undefined) throw new Error(`fixture entry ${key} missing`);
  return id;
}

function seed(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 't3-source-commit-'));
  const databasePath = join(directory, 'library.db');
  const database = openDatabase(databasePath);
  applyAllMigrations(database);

  const seedEntry = (key: string, title: string, originUrl: string): number => {
    const entry = createEntry(database, { title, type: 'comic' });
    createEntryContent(database, {
      entryId: entry.id,
      contentType: 'Source URL',
      content: originUrl,
      sortOrder: 0,
    });
    const entryId = Number(entry.id);
    entryIds[key] = entryId;
    return entryId;
  };
  const entryIds: Record<string, number> = {};
  const runId = createRun(database, {
    originSourceKey: 'known:hitomi',
    adapterKey: 'fake',
    targetOrigin: TARGET_ORIGIN,
    markOriginInvalid: false,
    settings: {},
  }).id;

  seedEntry('blueBox', 'Blue Box', 'https://hitomi.la/g/1.html');
  seedEntry('other', 'Other Work', 'https://hitomi.la/g/2.html');

  return {
    database,
    databasePath,
    entryIds,
    runId,
    cleanup: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function accept(fixture: Fixture, key: string, url: string): void {
  const entryId = entryIdOf(fixture, key);
  const entryTitle = fixture.database.prepare('SELECT title FROM entries WHERE id = ?')
    .pluck().get(entryId) as string;
  upsertItem(fixture.database, fixture.runId, {
    entryId,
    entryTitleSnapshot: entryTitle,
    originUrls: listEntrySources(fixture.database, entryId)
      .filter((source) => source.sourceKey === 'known:hitomi')
      .map((source) => source.url),
  });
  patchItem(fixture.database, fixture.runId, entryId, { decision: 'accept', selectedUrl: url });
}

function contentBytes(fixture: Fixture, entryId: number): Array<{ content: string; sort_order: number }> {
  return fixture.database.prepare(`
    SELECT content, sort_order FROM entry_contents
    WHERE entry_id = ? ORDER BY sort_order, id
  `).all(entryId) as Array<{ content: string; sort_order: number }>;
}

describe('source maintenance commit service', () => {
  it('appends accepted target URLs as new Source URL Contents and commits the run', async () => {
    const fixture = seed();
    try {
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      accept(fixture, 'other', `${TARGET_ORIGIN}/work/200`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      const result = await commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      });

      expect(result).toMatchObject({
        runId: fixture.runId,
        status: 'committed',
        createdCount: 2,
        skippedCount: 0,
        unresolvedCount: 0,
        originMarkedInvalid: false,
      });
      expect(getRun(fixture.database, fixture.runId)!.status).toBe('committed');
      // New Contents are appended after the old ones; old bytes unchanged.
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toEqual([
        { content: 'https://hitomi.la/g/1.html', sort_order: 0 },
        { content: 'https://fake.test/work/100', sort_order: 1 },
      ]);
      // The appended URLs are now live derived Sources.
      expect(listEntrySources(fixture.database, entryIdOf(fixture, 'blueBox')).map((source) => source.url))
        .toContain('https://fake.test/work/100');
      // A second commit attempt is rejected — the run is finished.
      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      })).rejects.toThrow(CommitConflictError);
    } finally {
      fixture.cleanup();
    }
  });

  it('skips idempotently when the Entry already contains the selected URL', async () => {
    const fixture = seed();
    try {
      createEntryContent(fixture.database, {
        entryId: entryIdOf(fixture, 'blueBox'),
        contentType: 'Source URL',
        content: `${TARGET_ORIGIN}/work/100`,
        sortOrder: 1,
      });
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      const result = await commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      });
      expect(result).toMatchObject({ createdCount: 0, skippedCount: 1 });
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('aborts the whole batch when two Entries select the same URL', async () => {
    const fixture = seed();
    try {
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      accept(fixture, 'other', `${TARGET_ORIGIN}/work/100`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      })).rejects.toThrow(CommitConflictError);
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(1);
      expect(contentBytes(fixture, entryIdOf(fixture, 'other'))).toHaveLength(1);
      expect(getRun(fixture.database, fixture.runId)!.status).toBe('review');
    } finally {
      fixture.cleanup();
    }
  });

  it('aborts with zero writes when a selected URL belongs to another Entry', async () => {
    const fixture = seed();
    try {
      // Other Work already owns the target URL in the live library.
      createEntryContent(fixture.database, {
        entryId: entryIdOf(fixture, 'other'),
        contentType: 'Source URL',
        content: `${TARGET_ORIGIN}/work/100`,
        sortOrder: 1,
      });
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      })).rejects.toThrow(CommitConflictError);
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects stale snapshots with zero writes', async () => {
    const fixture = seed();
    try {
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      // The Entry is renamed after the review started.
      fixture.database.prepare('UPDATE entries SET title = ? WHERE id = ?')
        .run('Blue Box (renamed)', entryIdOf(fixture, 'blueBox'));
      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      })).rejects.toThrow(CommitStaleError);
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(1);

      // Same for vanished origin URLs.
      fixture.database.prepare('UPDATE entries SET title = ? WHERE id = ?')
        .run('Blue Box', entryIdOf(fixture, 'blueBox'));
      fixture.database.prepare(`
        DELETE FROM entry_contents
        WHERE entry_id = ? AND content = 'https://hitomi.la/g/1.html'
      `).run(entryIdOf(fixture, 'blueBox'));
      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      })).rejects.toThrow(CommitStaleError);
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('prevents a batch when a selected URL is outside the target origin or unusable', async () => {
    const fixture = seed();
    try {
      accept(fixture, 'blueBox', 'https://elsewhere.example/x');
      updateRunStatus(fixture.database, fixture.runId, 'review');
      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      })).rejects.toThrow(CommitConflictError);

      patchItem(fixture.database, fixture.runId, entryIdOf(fixture, 'blueBox'),
        { selectedUrl: 'not a url at all' });
      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      })).rejects.toThrow(CommitConflictError);
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('commits the group invalid annotation atomically with the Contents', async () => {
    const fixture = seed();
    try {
      // The run must request the annotation up front; flipping it afterwards
      // is a live-settings change, so build a new run for that case.
      fixture.database.prepare('UPDATE source_maintenance_runs SET mark_origin_invalid = 1 WHERE id = ?')
        .run(fixture.runId);
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      const result = await commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      });
      expect(result.originMarkedInvalid).toBe(true);
      // Old URL is still present and clickable — only the badge changed.
      expect(listEntrySources(fixture.database, entryIdOf(fixture, 'blueBox')).map((source) => source.url))
        .toEqual(['https://hitomi.la/g/1.html', 'https://fake.test/work/100']);
      expect(setSourceStatus(fixture.database, 'known:hitomi', 'invalid').state).toBe('invalid');
    } finally {
      fixture.cleanup();
    }
  });

  it('rolls back all new Contents and the run state when the transaction fails', async () => {
    const fixture = seed();
    try {
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      accept(fixture, 'other', `${TARGET_ORIGIN}/work/200`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
        injectFailure: () => {
          throw new Error('injected failure');
        },
      })).rejects.toThrow('injected failure');

      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(1);
      expect(contentBytes(fixture, entryIdOf(fixture, 'other'))).toHaveLength(1);
      expect(getRun(fixture.database, fixture.runId)!.status).toBe('review');
      expect(fixture.database.prepare('SELECT COUNT(*) FROM source_statuses').pluck().get()).toBe(0);
      // The backup taken before the failed transaction still exists for review.
    } finally {
      fixture.cleanup();
    }
  });

  it('prevents the transaction when the backup cannot be created', async () => {
    const fixture = seed();
    try {
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      updateRunStatus(fixture.database, fixture.runId, 'review');

      await expect(commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: join(fixture.databasePath, 'missing-dir', 'library.db'),
        runId: fixture.runId,
      })).rejects.toThrow('backup failed');
      expect(contentBytes(fixture, entryIdOf(fixture, 'blueBox'))).toHaveLength(1);
      expect(getRun(fixture.database, fixture.runId)!.status).toBe('review');
    } finally {
      fixture.cleanup();
    }
  });

  it('counts unresolved items without blocking the accepted ones', async () => {
    const fixture = seed();
    try {
      accept(fixture, 'blueBox', `${TARGET_ORIGIN}/work/100`);
      // Other Work stays pending — it is simply not written.
      upsertItem(fixture.database, fixture.runId, {
        entryId: entryIdOf(fixture, 'other'),
        entryTitleSnapshot: 'Other Work',
        originUrls: ['https://hitomi.la/g/2.html'],
      });
      updateRunStatus(fixture.database, fixture.runId, 'review');

      const result = await commitSourceMaintenanceRun({
        database: fixture.database,
        databasePath: fixture.databasePath,
        runId: fixture.runId,
      });
      expect(result).toMatchObject({ createdCount: 1, skippedCount: 0, unresolvedCount: 1 });
    } finally {
      fixture.cleanup();
    }
  });
});
