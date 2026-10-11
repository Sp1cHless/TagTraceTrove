import io, os

fixes = [
 (r'D:\Project\TagTraceTrove\apps\server\tests\integration\author-resource-sync.integration.test.ts',
  "expect(capabilities.sqliteSchemaVersion).toBe(42);",
  "expect(capabilities.sqliteSchemaVersion).toBe(43);"),
 (r'D:\Project\TagTraceTrove\apps\server\tests\integration\backup-restore.integration.test.ts',
  "expect(version.version).toBe(42);",
  "expect(version.version).toBe(43);"),
 (r'D:\Project\TagTraceTrove\apps\server\tests\integration\offline-entry-tag-vocabulary.integration.test.ts',
  "expect(applyAllMigrations(database).currentVersion).toBe(42);",
  "expect(applyAllMigrations(database).currentVersion).toBe(43);"),
 (r'D:\Project\TagTraceTrove\apps\server\tests\integration\tag-facet-library-lifecycle.integration.test.ts', None, None),
 (r'D:\Project\TagTraceTrove\apps\server\tests\integration\tag-facet-origin-convergence.integration.test.ts', None, None),
 (r'D:\Project\TagTraceTrove\apps\server\tests\integration\delta-payload.integration.test.ts',
  'db.exec("UPDATE taxonomy_aliases SET canonical_name=\'Changed\',normalized_canonical=\'changed\'; UPDATE gallery_settings SET nsfw=0;");',
  '// taxonomy_aliases stays unjournaled; gallery_settings journals since 043.\n    db.exec("UPDATE taxonomy_aliases SET canonical_name=\'Changed\',normalized_canonical=\'changed\';");'),
]

for path, old, new in fixes:
    text = io.open(path, encoding='utf-8').read()
    if old is not None:
        assert old in text, path
        text = text.replace(old, new, 1)
    elif 'tag-facet-library-lifecycle' in path:
        marker = "expect(restored.prepare('SELECT MAX(version) FROM schema_migrations')"
        i = text.index(marker)
        assert text[i:i+300].count('.toBe(42)') == 1, text[i:i+300]
        text = text[:i] + text[i:i+300].replace('.toBe(42)', '.toBe(43)', 1) + text[i+300:]
    else:
        marker = '.toEqual({ applied: [35, 36, 37, 3'
        i = text.index(marker)
        seg = text[i:i+500]
        assert 'currentVersion: 42' in seg and '42,' in seg
        seg = seg.replace('42,', '42, 43,', 1).replace('currentVersion: 42', 'currentVersion: 43', 1)
        text = text[:i] + seg + text[i+500:]
    io.open(path, 'w', encoding='utf-8', newline='').write(text)
    print('fixed', os.path.basename(path))
