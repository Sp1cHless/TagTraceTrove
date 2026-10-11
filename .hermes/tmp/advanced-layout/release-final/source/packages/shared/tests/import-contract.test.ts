import { describe, expect, it } from 'vitest';
import { importCommitMappingSchema, importEntrySchema } from '../src/index.js';

describe('importEntrySchema', () => {
  it('accepts the canonical schema-neutral import shape', () => {
    const entry = importEntrySchema.parse({
      externalKey: 'example:42',
      title: 'Example',
      cover: 'items/42/cover.webp',
      tags: [{ name: 'Romance', sourceField: 'site tags' }],
      fields: { author: ['Author'] },
      sources: [{ label: 'Original site', url: 'https://example.test/item/42' }],
    });

    expect(entry.externalKey).toBe('example:42');
    expect(entry.fields).toEqual({ author: ['Author'] });
  });

  it('rejects blank titles and invalid source URLs', () => {
    expect(() =>
      importEntrySchema.parse({
        title: '   ',
        sources: [{ url: 'not a URL' }],
      }),
    ).toThrow();
  });
});

describe('importCommitMappingSchema', () => {
  it('requires explicit destinations for canonical and candidate data', () => {
    const mapping = importCommitMappingSchema.parse({
      entryType: 'comic',
      canonicalTagFacetId: 7,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      bodyContentType: 'body',
      fieldMappings: {
        authors: {
          kind: 'producer',
          createUnmatched: true,
          existingProducerIds: {},
        },
        characters: { kind: 'tag', facetId: 8 },
        language: { kind: 'content', contentType: 'language' },
      },
      ignoredFields: ['works'],
    });

    expect(mapping.fieldMappings.characters).toEqual({ kind: 'tag', facetId: 8 });
    expect(mapping.ignoredFields).toEqual(['works']);
  });

  it('rejects fields that are both mapped and explicitly ignored', () => {
    expect(importCommitMappingSchema.safeParse({
      entryType: 'comic',
      canonicalTagFacetId: 7,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      fieldMappings: { authors: { kind: 'producer' } },
      ignoredFields: ['authors'],
    }).success).toBe(false);
  });
});
