import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Explicit paths remain relative to the invoking shell; the default belongs to the server package. */
export function resolveCliDatabasePath(explicitPath: string | undefined, invocationDirectory: string): string {
  return explicitPath === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), '../../.data/library.db')
    : resolve(invocationDirectory, explicitPath);
}
