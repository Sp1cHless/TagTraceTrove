import type { HtmlSearchTemplate } from './template-html.js';
import { createTemplateHtmlAdapter } from './template-html.js';
import type { SourceSearchAdapter } from '../source-search-adapter.js';

/**
 * Manhuagui / 漫畫櫃 (tw.manhuagui.com) — the first config-driven target:
 * the whole adapter is this declarative template plus saved fixtures.
 * Search: `GET /s/<keyword>.html`, rows are `<li class="cf">` blocks under
 * `.book-result` with detail paths `/comic/<id>/`; the `<small>(…)</small>`
 * next to the title carries the alternate (often simplified/other-language)
 * title, which is valuable matching evidence.
 */

const ORIGIN = 'https://tw.manhuagui.com';

export const manhuaguiTemplate: HtmlSearchTemplate = {
  key: 'manhuagui',
  displayName: 'Manhuagui 漫畫櫃',
  origin: ORIGIN,
  hosts: ['tw.manhuagui.com', 'www.manhuagui.com', 'manhuagui.com'],
  searchUrl: (query) => `${ORIGIN}/s/${encodeURIComponent(query)}.html`,
  rowSplit: /<li class="cf">/gu,
  row: {
    urlPattern: /href="(\/comic\/\d+\/)"/u,
    urlTemplate: (match) => `${ORIGIN}${match[1]!.replace(/\/+$/u, '')}`,
    titlePattern: /<dt><a[^>]*title="([^"]*)"/u,
    coverPattern: /<img src="([^"]+)"/u,
    altTitlePattern: /<small>\(<a[^>]*>([^<]+)<\/a>\)<\/small>/u,
  },
  zeroResultMarkers: [/共查找到 <strong>0<\/strong>/u],
  counterPattern: /共查找到 <strong>(\d+)<\/strong>/u,
  rateLimit: { concurrency: 1, minDelayMs: 1500 },
  headers: { 'accept-language': 'zh-TW,zh;q=0.9' },
};

export function createManhuaguiAdapter(fetchImpl?: typeof fetch): SourceSearchAdapter {
  return createTemplateHtmlAdapter(manhuaguiTemplate, fetchImpl);
}
