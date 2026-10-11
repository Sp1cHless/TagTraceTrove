import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverHtmlSearch, createDiscoveredAdapter } from './adapters/generic-html.js';

/**
 * Blind-discovery probe for arbitrary target homepages (no hand-written
 * rules, no assumed language): for each homepage the engine discovers the
 * search endpoint by itself, probes with a title taken from the site itself,
 * subtracts a nonce search, and prints the resulting candidates. Raw pages
 * are saved as fixtures so unit tests can replay everything offline.
 */

const homepages = process.argv.slice(2);

function hostOf(homepage: string): string {
  return new URL(homepage).hostname.replace(/^www\./u, '');
}

async function main(): Promise<void> {
  for (const homepage of homepages) {
    const host = hostOf(homepage);
    const fixtureDirPath = fileURLToPath(new URL(`../../tests/fixtures/source-maintenance/generic/${host}/`, import.meta.url));
    mkdirSync(fixtureDirPath, { recursive: true });
    console.log(`=== ${homepage} ===`);
    try {
      const result = await discoverHtmlSearch(homepage, new AbortController().signal, fetch, {
        homepage: (html) => writeFileSync(join(fixtureDirPath, `${host}-home.html`), html),
        probe: (html) => writeFileSync(join(fixtureDirPath, `${host}-search.html`), html),
        nonce: (html) => writeFileSync(join(fixtureDirPath, `${host}-nonce.html`), html),
      });
      if (!result.ok) {
        console.log(`  UNSUPPORTED: ${result.failure.reason} (${result.failure.detail})`);
        continue;
      }
      const { discovery } = result;
      console.log(`  search endpoint : ${discovery.request.method} ${discovery.request.url}`);
      console.log(`  probe keyword   : "${discovery.probeKeyword}" (nonce "${discovery.nonceKeyword}")`);
      console.log(`  row signature   : ${discovery.rowSignature}`);
      console.log(`  result rows     : ${discovery.rows.length}`);
      for (const row of discovery.rows.slice(0, 5)) {
        console.log(`    - ${row.title.slice(0, 70)}`);
        console.log(`      ${row.url}`);
      }
      // Second live search with a different keyword proves the template
      // generalizes beyond the discovery probe.
      const secondKeyword = discovery.rows[0]?.title.slice(0, 20) ?? discovery.probeKeyword;
      const adapter = createDiscoveredAdapter(discovery);
      const secondRows = await adapter.search(secondKeyword, new AbortController().signal);
      console.log(`  second search   : "${secondKeyword}" -> ${secondRows.length} rows`);
      for (const row of secondRows.slice(0, 3)) {
        console.log(`    - ${row.title.slice(0, 70)} -> ${row.url}`);
      }
    } catch (cause) {
      console.log(`  ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    console.log();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
