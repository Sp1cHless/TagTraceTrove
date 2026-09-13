// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  CONVENTIONAL_SEARCH_SHAPES,
  decodeBody,
  discoverLooseInput,
  discoverSearchRequest,
  discoverHtmlSearch,
  groupRows,
} from '../../src/source-maintenance/adapters/generic-html.js';

const htmlResponse = (body: string, contentType = 'text/html; charset=utf-8'): Response =>
  new Response(body, { status: 200, headers: { 'content-type': contentType } });

describe('generic html discovery engine', () => {
  it('decodes charsets from the content-type header and meta tags', () => {
    const utf8 = decodeBody(new TextEncoder().encode('ok'), 'text/html; charset=utf-8');
    expect(utf8).toBe('ok');
    // Charset sniffing from the meta tag when the header omits it.
    const meta = '<html><head><meta charset="utf-8"></head><body>中文</body></html>';
    expect(decodeBody(new TextEncoder().encode(meta), 'text/html')).toContain('中文');
  });

  it('discovers a GET search form with hidden fields', () => {
    const html = `
      <form action="/search" method="get">
        <input type="hidden" name="type" value="all">
        <input type="text" name="searchkey">
        <button>go</button>
      </form>`;
    const request = discoverSearchRequest(html, 'https://site.example/');
    expect(request).toEqual({
      url: 'https://site.example/search?type=all&searchkey=%7Bkeyword%7D',
      method: 'GET',
    });
  });

  it('discovers a POST search form with a body template', () => {
    const html = `
      <form action="/search/do" method="post">
        <input type="text" name="keyword">
      </form>`;
    const request = discoverSearchRequest(html, 'https://site.example/');
    expect(request).toMatchObject({ url: 'https://site.example/search/do', method: 'POST' });
    expect(request?.body).toBe('keyword=%7Bkeyword%7D');
  });

  it('falls back to a bare named input outside any form', () => {
    const html = `<div class="searchbar"><input type="text" id="key" name="key"><button onclick="doSearch()"></button></div>`;
    const request = discoverLooseInput(html, 'https://site.example/home');
    expect(request).toEqual({ url: 'https://site.example/home?key={keyword}', method: 'GET' });
  });

  it('groups rows by URL signature and never crosses origins', () => {
    const html = `
      <a href="/comic/101/">Alpha</a>
      <a href="/comic/102/">Beta</a>
      <a href="/other/1/">Gamma</a>
      <a href="https://else.example/comic/103/">External</a>`;
    const groups = groupRows(html, 'https://site.example/');
    const comic = groups.get('/comic/{d}/') ?? [];
    expect(comic.map((row) => row.title)).toEqual(['Alpha', 'Beta']);
    expect(groups.has('/other/{d}/')).toBe(true);
  });

  it('runs the whole layered discovery against a synthetic site (injected fetch)', { timeout: 30000 }, async () => {
    const homepage = `
      <html><body>
        <a href="/manhua/17316/">不相信人类的冒险者们好像要去拯救世界在线漫画</a>
        <a href="/manhua/12010/">鬼话连篇在线漫画</a>
      </body></html>`;
    const searchPage = (keyword: string): string => `
      <html><body>
        <div class="result">search: ${keyword}</div>
        <a href="/manhua/12010/">鬼话连篇在线漫画</a>
        ${keyword === 'zzqqxxvvuumm0417'
          ? '<a href="/manhua/88888/">随机推荐甲</a><a href="/manhua/88889/">随机推荐乙</a>'
          : '<a href="/manhua/17316/">不相信人类的冒险者们好像要去拯救世界在线漫画</a><a href="/manhua/99999/">只有真搜索才出现的标题</a>'}
      </body></html>`;
    const seen: string[] = [];
    const doFetch = ((url: string | URL) => {
      seen.push(String(url));
      const raw = String(url);
      if (raw.endsWith('/')) return Promise.resolve(htmlResponse(homepage));
      const keyword = /title=([^&]+)/u.exec(raw)?.[1] ?? '';
      const decoded = decodeURIComponent(keyword);
      return Promise.resolve(htmlResponse(searchPage(decoded)));
    }) as unknown as typeof fetch;

    const result = await discoverHtmlSearch('https://site.example/', new AbortController().signal, doFetch, {}, { probeNonceMs: 0, betweenCandidatesMs: 0 });
    // The form layer misses, the loose-input layer misses (no inputs), and a
    // conventional shape (`/search?title=`) carries the differential rows.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.discovery.request.url).toContain('/search?title=');
    expect(result.discovery.rows.map((row) => row.title)).toContain('不相信人类的冒险者们好像要去拯救世界在线漫画');
    expect(seen.length).toBeGreaterThan(2);
  });

  it('reports every conventional shape exhausted when nothing differentiates', { timeout: 30000 }, async () => {
    const sameForAll = (keyword: string): string =>
      `<html><body><p>search ${keyword}</p><a href="/x/1/">总是出现的推荐</a><a href="/x/2/">总是出现的推荐二</a></body></html>`;
    const doFetch = ((url: string | URL) => {
      const raw = String(url);
      const keyword = /[?/=]([^/?]*?)(?:\\.html)?$/u.exec(raw)?.[1] ?? 'kw';
      return Promise.resolve(htmlResponse(sameForAll(decodeURIComponent(keyword))));
    }) as unknown as typeof fetch;
    const result = await discoverHtmlSearch('https://spa.example/', new AbortController().signal, doFetch, {}, { probeNonceMs: 0, betweenCandidatesMs: 0 });
    expect(result).toMatchObject({ ok: false, failure: { reason: 'no-differential-rows' } });
  });

  it('keeps the conventional shape set bounded', () => {
    expect(CONVENTIONAL_SEARCH_SHAPES.length).toBeLessThanOrEqual(20);
  });
});
