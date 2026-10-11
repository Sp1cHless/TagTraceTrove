import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliDatabasePath } from '../../src/database/cli-path.js';

describe('backup/restore CLI database path', () => {
  it('targets the server data directory regardless of where pnpm was invoked', () => {
    const expected = resolve(fileURLToPath(new URL('../../.data/library.db', import.meta.url)));
    expect(resolveCliDatabasePath(undefined, 'C:/elsewhere')).toBe(expected);
    expect(resolveCliDatabasePath(undefined, 'D:/Project/TagTraceTrove')).toBe(expected);
    expect(resolveCliDatabasePath('custom.db', 'C:/elsewhere')).toBe(resolve('C:/elsewhere/custom.db'));
  });
});
