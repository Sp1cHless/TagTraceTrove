from pathlib import Path
import hashlib, json
original = Path('.hermes/tmp/recovery2-snapshot-candidate.ts')
source = original.read_text(encoding='utf8')
assert hashlib.sha256(source.encode()).hexdigest() == '4f35e9ba8c05d705a2d0597d5ad57dc121d649b2748c1d09ae3085a73d216efc'
bundle = next(Path('apps/web/dist/assets').glob('index-*.js'))
compiled = bundle.read_text(encoding='utf8')
helper_offset = compiled.index('async function ye(e,t){try{let n=((await te())?.getEntry(e))?.sections')
method_offset = compiled.index('async assignEntryTag(t,n){return C(`entry-tags-set`')
helper_evidence = compiled[helper_offset:compiled.index('async function P(', helper_offset)]
method_evidence = compiled[method_offset:compiled.index('async moveEntryTag(', method_offset)]
assert 'await ye(t,n)' in method_evidence and 'return h(`online`),r' in method_evidence
anchor = '  async function enqueueEntryTags(\n'
assert source.count(anchor) == 1
helper = '''  // Restored from the previously delivered v40 bundle (offline Tag write result).
  async function offlineAssignedTag(entryId: number, input: { facetId: number; name: string }): ReturnType<GalleryApi['assignEntryTag']> {
    try {
      const facet = (await loadOfflineLibrary())?.getEntry(entryId)?.sections
        .flatMap(section => section.facets).find(row => row.id === input.facetId);
      if (facet === undefined) return null;
      const normalized = normalizeTag(input.name);
      const tag = facet.tags.find(row => normalizeTag(row.name) === normalized);
      return tag === undefined ? null : {
        tagId: tag.id, name: tag.name, normalizedName: normalizeTag(tag.name), facetId: facet.id,
      };
    } catch { return null; }
  }

'''
source = source.replace(anchor, helper + anchor, 1)
a = source.index('    async assignEntryTag(entryId, input) {')
b = source.index('    async moveEntryTag(', a)
method = source[a:b]
old = '        const enqueue = (cause?: unknown) => enqueueEntryTags(entryId, (tags, snapshot) => {'
new = '        const enqueue = async (cause?: unknown) => {\n          await enqueueEntryTags(entryId, (tags, snapshot) => {'
assert method.count(old) == 1
method = method.replace(old, new, 1)
old = '        }, cause);\n        if (mode'
new = '          }, cause);\n          return offlineAssignedTag(entryId, input);\n        };\n        if (mode'
assert method.count(old) == 1
method = method.replace(old, new, 1)
old = '          await online.assignEntryTag(entryId, input);\n          setMode(\'online\');'
new = '          const result = await online.assignEntryTag(entryId, input);\n          setMode(\'online\');\n          return result;'
assert method.count(old) == 1
method = method.replace(old, new, 1)
source = source[:a] + method + source[b:]
output = Path('.hermes/tmp/recovery3-bundle-candidate.ts')
output.write_text(source, encoding='utf8')
report = {'candidate': str(output.resolve()), 'bytes': len(source.encode()), 'lines': len(source.splitlines()), 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'bundle': str(bundle), 'bundle_sha256': hashlib.sha256(bundle.read_bytes()).hexdigest(), 'helper_offset': helper_offset, 'helper_evidence': helper_evidence, 'method_offset': method_offset, 'method_evidence': method_evidence, 'scope': 'Behavior restored from delivered compiled artifact; not original source-byte recovery'}
Path('.hermes/tmp/recovery3-bundle-evidence.json').write_text(json.dumps(report, indent=2), encoding='utf8')
print(json.dumps({key: report[key] for key in ['candidate', 'bytes', 'lines', 'sha256', 'scope']}))
