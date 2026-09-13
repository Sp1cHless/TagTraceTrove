import type { TitleCatalogProvider } from '../catalog-provider.js';
import { createBangumiProvider } from './bangumi.js';
import { createKitsuProvider } from './kitsu.js';
import { createMangaDexProvider } from './mangadex.js';
import { createWikidataProvider } from './wikidata.js';

/**
 * Live catalog providers in the plan's evidence priority order (§10.1).
 * Provider failure only lowers evidence; it never fails the run.
 */
export function defaultCatalogProviders(): TitleCatalogProvider[] {
  return [
    createBangumiProvider((url, init) => fetch(url, init)),
    createMangaDexProvider((url, init) => fetch(url, init)),
    createWikidataProvider((url, init) => fetch(url, init)),
    createKitsuProvider((url, init) => fetch(url, init)),
  ];
}
