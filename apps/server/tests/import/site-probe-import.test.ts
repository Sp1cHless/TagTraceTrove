import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImportPreview } from '../../src/import/preview.js';
import { loadSiteProbeExport } from '../../src/import/site-probe.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function writeMetadata(document: unknown): Promise<{ directory: string; metadataPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 't3-site-probe-'));
  temporaryDirectories.push(directory);
  const metadataPath = join(directory, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify(document), 'utf8');
  return { directory, metadataPath };
}

interface HitomiWorkFixture {
  source_id: string;
  title: string;
  language?: unknown;
  分类信息?: Record<string, string[]>;
}

/** Writes a Hitomi author export: a manifest plus one folder per work. */
async function writeHitomiAuthorExport(
  works: HitomiWorkFixture[],
  options: { manifestItems?: string[] } = {},
): Promise<{ directory: string; metadataPath: string }> {
  const { directory, metadataPath } = await writeMetadata({
    source_site: 'hitomi.la',
    artist: 'Example Artist',
    items: options.manifestItems ?? works.map((work) => work.source_id),
  });
  for (const work of works) {
    const itemDirectory = join(directory, 'items', work.source_id);
    await mkdir(itemDirectory, { recursive: true });
    await writeFile(join(itemDirectory, 'metadata.json'), JSON.stringify({
      source_site: 'hitomi.la',
      source_id: work.source_id,
      title: work.title,
      detail_url: `https://hitomi.la/example-${work.source_id}.html`,
      分类信息: work.分类信息 ?? {
        作品: [],
        登场人物: [],
        分类标签: [],
        作者: ['Example Artist'],
        作品类型: [],
      },
      ...(work.language === undefined ? {} : { language: work.language }),
    }), 'utf8');
  }
  return { directory, metadataPath };
}

describe('loadSiteProbeExport', () => {
  it('adapts an 18comic export without assuming database fields', async () => {
    const { directory, metadataPath } = await writeMetadata({
      source_site: '18comic.vip',
      items: [
        {
          source_site: '18comic.vip',
          source_id: '42',
          title: 'Example comic',
          detail_url: 'https://18comic.vip/album/42/',
          分类信息: {
            作品: ['Example Series'],
            登场人物: ['Example Character'],
            分类标签: ['Full Color'],
            作者: ['Example Author'],
          },
          cover: { local_path: 'items/42/cover/cover.webp' },
        },
      ],
    });

    const batch = await loadSiteProbeExport(metadataPath);

    expect(batch.source).toBe('18comic.vip');
    expect(batch.entries).toEqual([
      {
        externalKey: '18comic.vip:42',
        title: 'Example comic',
        cover: join(directory, 'items/42/cover/cover.webp'),
        tags: [{ name: 'Full Color', sourceField: '分类标签' }],
        fields: {
          works: ['Example Series'],
          characters: ['Example Character'],
          authors: ['Example Author'],
        },
        sources: [{ label: '18comic.vip', url: 'https://18comic.vip/album/42/' }],
      },
    ]);
    expect(batch.warnings).toEqual([]);
  });

  it('adapts a Hanime1 playlist while keeping playback outside the import model', async () => {
    const { directory, metadataPath } = await writeMetadata({
      source_site: 'hanime1.me',
      playlist_id: '7',
      items: [
        {
          source_site: 'hanime1.me',
          source_id: '99',
          title: 'Example video',
          video_url: 'https://hanime1.me/watch?v=99',
          author: 'Example Author',
          source_tags_raw: ['Pending Tag', 'Accepted Tag'],
          tags: ['Accepted Tag'],
          cover: { local_path: 'items/99/cover/cover.jpg' },
        },
      ],
    });

    const batch = await loadSiteProbeExport(metadataPath);

    expect(batch.entries).toEqual([
      {
        externalKey: 'hanime1.me:99',
        title: 'Example video',
        cover: join(directory, 'items/99/cover/cover.jpg'),
        tags: [{ name: 'Accepted Tag', sourceField: 'tags' }],
        fields: {
          authors: ['Example Author'],
          sourceTagsRaw: ['Pending Tag', 'Accepted Tag'],
        },
        sources: [{ label: 'hanime1.me', url: 'https://hanime1.me/watch?v=99' }],
      },
    ]);
  });

  it('loads Hitomi item documents referenced by an author manifest', async () => {
    const { directory, metadataPath } = await writeMetadata({
      source_site: 'hitomi.la',
      artist: 'Example Artist',
      items: ['123'],
    });
    const itemDirectory = join(directory, 'items', '123');
    await mkdir(itemDirectory, { recursive: true });
    await writeFile(
      join(itemDirectory, 'metadata.json'),
      JSON.stringify({
        source_site: 'hitomi.la',
        source_id: '123',
        title: 'Example work',
        detail_url: 'https://hitomi.la/example-123.html',
        分类信息: {
          作品: ['Example Series'],
          登场人物: ['Example Character'],
          分类标签: ['Full Color'],
          作者: ['Example Artist'],
          作品类型: ['Doujinshi'],
        },
        language: { code: 'chinese', name: '中文' },
        date_added: '2026-01-02 03:04:05-05',
        page_count: 12,
        cover: { local_path: 'items/123/cover/cover.webp' },
      }),
      'utf8',
    );

    const batch = await loadSiteProbeExport(metadataPath);

    expect(batch.entries).toEqual([
      {
        externalKey: 'hitomi.la:123',
        title: 'Example work',
        cover: join(directory, 'items/123/cover/cover.webp'),
        tags: [{ name: 'Full Color', sourceField: '分类标签' }],
        fields: {
          works: ['Example Series'],
          characters: ['Example Character'],
          authors: ['Example Artist'],
          contentTypes: ['Doujinshi'],
          language: ['中文'],
        },
        pageCount: 12,
        uploadDate: '2026-01-02',
        sources: [{ label: 'hitomi.la', url: 'https://hitomi.la/example-123.html' }],
      },
    ]);
  });

  it('loads a directly selected Hitomi item folder with paths relative to that folder', async () => {
    const { metadataPath } = await writeMetadata({
      source_site: 'hitomi.la',
      source_id: '3220586',
      title: 'Artist ::: Akchu',
      detail_url: 'https://hitomi.la/imageset/example-3220586.html',
      分类信息: {
        作品: ['Azur Lane'],
        登场人物: ['Honolulu'],
        分类标签: ['Big Breasts'],
        作者: ['Akchu'],
        作品类型: ['Image Set'],
      },
      language: { code: 'japanese', name: '日本語' },
      cover: { local_path: 'items/3220586/cover/cover.webp' },
      preview_images: [{ local_path: 'items/3220586/previews/00002.webp' }],
    });

    const batch = await loadSiteProbeExport(metadataPath, { preserveRelativeMediaPaths: true });

    expect(batch.entries).toMatchObject([{
      externalKey: 'hitomi.la:3220586',
      title: 'Artist ::: Akchu',
      cover: 'cover/cover.webp',
      preview: 'previews/00002.webp',
      fields: {
        works: ['Azur Lane'],
        characters: ['Honolulu'],
        authors: ['Akchu'],
        contentTypes: ['Image Set'],
        language: ['日本語'],
      },
    }]);
  });
  it('loads a directly selected 18comic item folder with unified fields and relative media paths', async () => {
    const { metadataPath } = await writeMetadata({
      source_site: '18comic.vip',
      source_id: '50721',
      title: 'Example comic',
      detail_url: 'https://18comic.vip/album/50721/',
      分类信息: {
        作品: ['Example Series'],
        登场人物: ['Example Character'],
        分类标签: ['中文'],
        作者: ['Example Author'],
        作品类型: ['Doujinshi'],
      },
      language: { code: 'chinese', name: '中文' },
      date_added: '2018-03-18',
      page_count: 28,
      cover: { local_path: 'items/50721/cover/cover.jpg' },
      preview_images: [
        { local_path: 'items/50721/previews/00001.webp' },
        { local_path: 'items/50721/previews/00019.webp' },
      ],
    });

    const batch = await loadSiteProbeExport(metadataPath, { preserveRelativeMediaPaths: true });

    expect(batch.entries).toMatchObject([{
      externalKey: '18comic.vip:50721',
      cover: 'cover/cover.jpg',
      preview: 'previews/00001.webp',
      previews: ['previews/00001.webp', 'previews/00019.webp'],
      uploadDate: '2018-03-18',
      pageCount: 28,
      // 中文 appears as a plain tag on 18comic AND as language.name; the tag
      // copy is dropped so commit cannot collide across Facets.
      tags: [],
      fields: {
        works: ['Example Series'],
        characters: ['Example Character'],
        authors: ['Example Author'],
        contentTypes: ['Doujinshi'],
        language: ['中文'],
      },
    }]);
  });

  it('loads a directly selected Hanime item folder with unified category fields', async () => {
    const { metadataPath } = await writeMetadata({
      source_site: 'hanime1.me',
      source_id: '99737',
      title: 'Example video',
      video_url: 'https://hanime1.me/watch?v=99737',
      detail_url: 'https://hanime1.me/watch?v=99737',
      author: 'Example Author',
      source_tags_raw: ['Accepted Tag'],
      tags: ['Accepted Tag'],
      分类信息: {
        作品: ['Example Series'],
        登场人物: ['Example Character'],
        分类标签: ['Accepted Tag'],
        作者: ['Example Author'],
        作品类型: [],
      },
      language: { code: '', name: '' },
      date_added: null,
      page_count: null,
      cover: { local_path: 'items/99737/cover/cover.jpg' },
      preview_images: [],
    });

    const batch = await loadSiteProbeExport(metadataPath, { preserveRelativeMediaPaths: true });

    expect(batch.entries).toMatchObject([{
      externalKey: 'hanime1.me:99737',
      cover: 'cover/cover.jpg',
      fields: {
        works: ['Example Series'],
        characters: ['Example Character'],
        authors: ['Example Author'],
        contentTypes: [],
        sourceTagsRaw: ['Accepted Tag'],
      },
    }]);
  });

  it('imports Hitomi works whose language is unknown instead of rejecting the folder', async () => {
    const { metadataPath } = await writeHitomiAuthorExport([
      { source_id: '1668831', title: 'No language at all', language: { code: null, name: null } },
      { source_id: '3868000', title: 'Code without name', language: { code: 'textless narrative', name: null } },
      { source_id: '2000000', title: 'Known language', language: { code: 'chinese', name: '中文' } },
    ]);

    const batch = await loadSiteProbeExport(metadataPath);

    expect(batch.entries.map((entry) => entry.fields)).toEqual([
      { works: [], characters: [], authors: ['Example Artist'], contentTypes: [] },
      { works: [], characters: [], authors: ['Example Artist'], contentTypes: [] },
      { works: [], characters: [], authors: ['Example Artist'], contentTypes: [], language: ['中文'] },
    ]);
    expect(batch.warnings).toEqual([]);
  });

  it('skips a manifest work with no metadata file and reports it instead of failing the folder', async () => {
    const { directory, metadataPath } = await writeHitomiAuthorExport(
      [{ source_id: '111', title: 'Present work' }],
      { manifestItems: ['111', '888260'] },
    );
    await mkdir(join(directory, 'items', '888260'), { recursive: true });

    const batch = await loadSiteProbeExport(metadataPath);

    expect(batch.entries.map((entry) => entry.title)).toEqual(['Present work']);
    expect(batch.warnings).toEqual([
      'Skipped work 888260: items/888260/metadata.json is missing',
    ]);
  });

  it('names the offending work when a manifest item does not match the export schema', async () => {
    const { metadataPath } = await writeHitomiAuthorExport([
      { source_id: '5', title: '   ' },
    ]);

    await expect(loadSiteProbeExport(metadataPath)).rejects.toThrow(
      /Export work 5 does not match the hitomi\.la export schema: title/u,
    );
  });
});

describe('createImportPreview', () => {
  it('summarizes a canonical batch without querying a database', () => {
    expect(
      createImportPreview({
        source: 'example.test',
        warnings: ['One source warning'],
        entries: [
          { title: 'One', cover: 'cover.webp', tags: [{ name: 'A' }, { name: 'B' }] },
          { title: 'Two', tags: [{ name: 'A' }] },
        ],
      }),
    ).toEqual({
      source: 'example.test',
      entryCount: 2,
      tagAssignmentCount: 3,
      uniqueTagCount: 2,
      entriesMissingCover: 1,
      warnings: ['One source warning'],
    });
  });
});