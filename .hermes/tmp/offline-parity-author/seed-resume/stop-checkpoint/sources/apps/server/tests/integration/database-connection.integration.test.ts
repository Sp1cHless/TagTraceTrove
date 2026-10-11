import { afterEach, describe, expect, it } from 'vitest';
import { normalizeTag } from '@t3/shared';
import {
  createMemoryDatabase,
  createTempFileDatabase,
  type TempFileDatabase,
} from '../../src/database/testing.js';

const temporaryDatabases: TempFileDatabase[] = [];

afterEach(() => {
  for (const temporaryDatabase of temporaryDatabases.splice(0)) {
    temporaryDatabase.cleanup();
  }
});

describe('SQLite test database helpers', () => {
  it('creates an isolated in-memory database with safety pragmas', () => {
    const database = createMemoryDatabase();

    try {
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(database.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(normalizeTag('  School   Life  ')).toBe('school life');
    } finally {
      database.close();
    }
  });

  it('creates a disposable file database with WAL enabled', () => {
    const temporaryDatabase = createTempFileDatabase();
    temporaryDatabases.push(temporaryDatabase);

    expect(temporaryDatabase.database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(temporaryDatabase.path.endsWith('library.db')).toBe(true);
  });
});
