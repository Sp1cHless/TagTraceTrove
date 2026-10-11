from pathlib import Path
import json
p = Path('.hermes/tmp/recovery3-bundle-candidate.ts')
s = p.read_text(encoding='utf8')
Path('.hermes/tmp/recovery3-bundle-tag-only.ts').write_text(s,encoding='utf8')
a = s.index('  async function enqueueOfflineEntryCreate(')
b = s.index('  function pendingContentValues(', a)
block = s[a:b]
def change(old,new):
 global block
 assert block.count(old)==1,old[:100]
 block=block.replace(old,new,1)
change("    if (await store.readMeta(ENTRY_CREATE_CAPABILITY_KEY) !== '1') {", "    const preset = input.presetCreateOperation !== undefined && input.presetCreateOperation.operationKind === 'entry.create'\n      ? input.presetCreateOperation : undefined;\n    if (preset !== undefined && (preset.libraryId !== active.snapshot.header.libraryId || preset.syncEpoch !== active.snapshot.header.syncEpoch)) {\n      throw new Error('This offline copy belongs to a different library revision; refresh it while online');\n    }\n    if (await store.readMeta(ENTRY_CREATE_CAPABILITY_KEY) !== '1') {")
change("    if (input.contents?.length && await store.readMeta(ENTRY_INITIAL_CONTENTS_CAPABILITY_KEY) !== '1') {", "    if (((input.contents?.length ?? 0) > 0 || (preset !== undefined && (preset.payload.contents?.length ?? 0) > 0))\n      && await store.readMeta(ENTRY_INITIAL_CONTENTS_CAPABILITY_KEY) !== '1') {")
change('    const title = input.title.trim();\n    const type = input.type.trim();', '    const title = (preset === undefined ? input.title : preset.payload.title).trim();\n    const type = (preset === undefined ? input.type : preset.payload.type).trim();')
start = block.index('    const parsed = parsedEntryOperations(operations);')
end = block.index('    const entityUid = input.syncUid ?? randomUUID();', start)
rating = block[start:end]
rating = rating.replace('    const ratings = input.ratings.map((rating) => {', '    return input.ratings.map((rating) => {', 1)
change(block[start:end], "    const ratings = preset === undefined ? await (async () => {\n" + rating + "    })() : preset.payload.ratings.map(rating => rating.slotUid === undefined\n      ? { slotId: rating.slotId, stars: rating.stars } : { slotUid: rating.slotUid, stars: rating.stars });\n")
change('    const entityUid = input.syncUid ?? randomUUID();', '    const entityUid = preset === undefined ? input.syncUid ?? randomUUID() : preset.entityUid;')
change('    const operation = createPendingSyncOperation({', '    const operation: PendingSyncOperation = preset === undefined ? createPendingSyncOperation({')
change('    }, { randomUUID });\n    const normalized = {', '''    }, { randomUUID }) : {
      clientId: preset.clientId, libraryId: preset.libraryId, syncEpoch: preset.syncEpoch,
      entityKind: 'entry', entityUid: preset.entityUid, operationKind: 'entry.create',
      baseVersion: 0, baseValues: {}, opId: preset.opId, clientCreatedAt: preset.clientCreatedAt,
      payload: {
        title: preset.payload.title, type: preset.payload.type,
        uploadDate: preset.payload.uploadDate, pageCount: preset.payload.pageCount,
        ratings, viewLater: preset.payload.viewLater,
        ...(preset.payload.contents === undefined ? {} : { contents: preset.payload.contents.map(row => ({
          syncUid: row.syncUid, contentType: row.contentType, content: row.content, sortOrder: row.sortOrder,
        })) }),
      },
      status: 'pending', lastAttemptAt: null, lastError: null,
    };
    const normalized = {''')
s=s[:a]+block+s[b:]
a=s.index('  async function discardBlockedOfflineOperations():')
b=s.index('  const facade:',a)
block=s[a:b]
change('    const operations = await store.list();\n    const firstBlockedIndexByEntity', '    const operations = await store.list();\n    const active = await readActiveSnapshot(store);\n    const currentLibraryId = active?.snapshot.header.libraryId;\n    const currentSyncEpoch = active?.snapshot.header.syncEpoch;\n    const firstBlockedIndexByEntity')
change("      if (operation.status !== 'conflict' && operation.status !== 'failed') return;", "      if (operation.status !== 'conflict' && operation.status !== 'failed'\n        && (currentLibraryId === undefined || (operation.libraryId === currentLibraryId && operation.syncEpoch === currentSyncEpoch))) return;")
s=s[:a]+block+s[b:]
p.write_text(s,encoding='utf8')
bundle=next(Path('apps/web/dist/assets').glob('index-*.js'))
c=bundle.read_text()
a=c.index('async function Te(e,r){if(r!==void 0&&!rF(r))throw r;if(!FI(t))throw Error(`Offline create storage is unavailable`)')
b=c.index('function Ee(',a)
f=c.index('async function qe(){if(!PI(t))return;let e=await t.list(),r=await AF(t)')
g=c.index('ee().catch',f)
Path('.hermes/tmp/recovery3-create-discard-evidence.json').write_text(json.dumps({'bundle':str(bundle),'create':c[a:b],'discard':c[f:g],'scope':'Reconstructs known original behavior from actual delivered bundle, not original byte equality'},indent=2),encoding='utf8')
print('candidate lines',len(s.splitlines()))
