import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manhuaguiTemplate, createManhuaguiAdapter } from '../../src/source-maintenance/adapters/manhuagui.js';
import { parseWithTemplate, TemplateStructureError } from '../../src/source-maintenance/adapters/template-html.js';
import { probeTargetHomepage } from '../../src/source-maintenance/adapter-registry.js';

const fixture = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../fixtures/source-maintenance/manhuagui/${name}`, import.meta.url)),
  'utf8',
);

describe('manhuagui template adapter (saved fixtures, no network)', () => {
  it('parses the real search page: canonical URL, title, cover and the alternate title', () => {
    const candidates = parseWithTemplate(fixture('search-blue-box.html'), manhuaguiTemplate);
    expect(candidates).toHaveLength(1);
    const only = candidates[0]!;
    expect(only.url).toBe('https://tw.manhuagui.com/comic/37130');
    expect(only.title).toBe('青色之箱');
    expect(only.thumbnailUrl).toBe('https://cf.mhgui.com/cpic/b/37130.jpg');
    expect((only.adapterEvidence.altTitles as string[])).toEqual(['藍箱']);
  });

  it('returns empty for the real zero-result page', () => {
    expect(parseWithTemplate(fixture('search-no-result.html'), manhuaguiTemplate)).toEqual([]);
  });

  it('fails closed when the counter reports hits but rows were destroyed', () => {
    const broken = fixture('search-blue-box.html').replace(/<li class="cf">/gu, '<li class="cf-x">');
    expect(() => parseWithTemplate(broken, manhuaguiTemplate)).toThrow(TemplateStructureError);
  });

  it('accepts every host variant through the registry probe', () => {
    for (const homepage of ['https://tw.manhuagui.com/list/view.html', 'https://www.manhuagui.com/', 'https://manhuagui.com/']) {
      const probe = probeTargetHomepage(homepage);
      expect(probe.ok, homepage).toBe(true);
      if (probe.ok) expect(probe.adapter.key).toBe('manhuagui');
    }
  });

  it('builds polite, encoded search URLs', async () => {
    expect(manhuaguiTemplate.searchUrl('青色之箱', 1))
      .toBe('https://tw.manhuagui.com/s/%E9%9D%92%E8%89%B2%E4%B9%8B%E7%AE%B1.html');
    let requestUrl: string | null = null;
    const adapter = createManhuaguiAdapter(((url: string | URL) => {
      requestUrl = String(url);
      return Promise.resolve(new Response(fixture('search-blue-box.html'), { status: 200 }));
    }) as unknown as typeof fetch);
    const candidates = await adapter.search({ title: '青色之箱', signal: AbortSignal.timeout(1000) });
    expect(candidates).toHaveLength(1);
    expect(requestUrl).toBe('https://tw.manhuagui.com/s/%E9%9D%92%E8%89%B2%E4%B9%8B%E7%AE%B1.html');
  });
});
