from guard import *
f='apps/web/src/offline/offline-api.ts'
edit(f,"['offlineStandaloneAuthorCreate', 'offlineEntryDelete'", "['offlineAuthorDelete', 'offlineStandaloneAuthorCreate', 'offlineEntryDelete'")
edit(f,'const prior = parsedAuthorOperations(rows).filter','const prior = parsedEntryOperations(rows).filter')
edit(f,'{entityId?:number; resourceVersion:number; serverSeq:number}>','{entityId:number | undefined; resourceVersion:number; serverSeq:number}>')
f='apps/web/tests/offline-author-parity.integration.test.ts'
edit(f,"globalThis.addEventListener=window.addEventListener.bind(window);", "window.scrollTo=vi.fn();globalThis.addEventListener=window.addEventListener.bind(window);")
