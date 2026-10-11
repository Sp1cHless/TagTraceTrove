/**
 * Import a real SiteProbe export through the real HTTP routes, into a scratch library.
 *
 * Reads the user's export tree and writes only into the scratch data dir it was started with.
 * Prints what the import did with the media, and the order the Entry's pictures ended up in.
 */
const base = 'http://127.0.0.1:8799';
const listing = process.argv[2];
if (!listing) throw new Error('pass the listing metadata.json path');

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(payload)}`);
  return payload as T;
}

// 1. The Entry type the import will file these works under, and the Facet tags land on.
const section = await post<{ id: number; defaultFacetId: number }>('/api/sections', {
  entryType: '漫画',
  name: '分类',
});
console.log('section', section.id, 'default facet', section.defaultFacetId);

// 2. What the export holds.
const preview = await post<{
  batch: {
    entries: Array<{
      title: string;
      cover?: string;
      previews?: string[];
      fields?: Record<string, unknown>;
    }>;
  };
}>('/api/imports/site-probe/preview-path', { metadataPath: listing });
const entry = preview.batch.entries[0]!;
console.log('batch entry:', entry.title);
console.log('  cover    ', entry.cover);
console.log('  previews ', entry.previews);
console.log('  fields   ', Object.keys(entry.fields ?? {}));

// 3. Commit it: every field either mapped or explicitly ignored, since commit refuses a field
// nobody decided about. The author goes to a producer; the rest are ignored for this check.
// Every field ignored: an unmatched producer has to be approved by a person, and this run is
// about the media and the order the Entry's pictures end up in, not about author matching.
const ignored = Object.keys(entry.fields ?? {});
const commit = await post<{
  entryId: number;
  mediaStoredCount?: number;
  mediaDuplicateCount?: number;
  mediaWarnings?: string[];
  entries: Array<{ entryId: number; title: string }>;
}>('/api/imports/commit-path', {
  batch: preview.batch,
  mapping: {
    entryType: '漫画',
    canonicalTagFacetId: section.defaultFacetId,
    sourceContentType: 'source url',
    externalKeyContentType: 'external key',
    fieldMappings: {},
    ignoredFields: ignored,
    authorRatings: [],
  },
});
console.log('commit:', JSON.stringify({
  mediaStoredCount: commit.mediaStoredCount,
  mediaDuplicateCount: commit.mediaDuplicateCount,
  mediaWarnings: commit.mediaWarnings,
}));

// 4. What the Entry now leads with: the order the stack is built from.
const entryId = commit.entries[0]!.entryId;
const detail = await (await fetch(`${base}/api/entries/${entryId}`)).json() as {
  coverRef?: string | null;
  previewRefs?: string[];
};
console.log('entry', entryId, 'coverRef:', detail.coverRef);
console.log('            previewRefs:', detail.previewRefs);
