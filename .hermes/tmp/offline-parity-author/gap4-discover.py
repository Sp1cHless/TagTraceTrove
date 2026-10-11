from pathlib import Path
R=Path('D:/Project/TagTraceTrove')
for p,terms in [('apps/web/src/GalleryApp.vue',['function showAuthors','creationView.value = \'author\'','collectionsView.value','randomView.value']),('packages/shared/src/schemas/sync.ts',['producerCreate','ProducerCreate','authorDirectory','sourceOrigin']),('apps/server/src/sync/replay-service.ts',['producer.create','author_directory_sets','createOrigin','sourceOrigin']),('apps/web/src/offline/offline-api.ts',['authorDirectorySets:','authorDirectorySets =','producerVersionAdvances','originFor','SourceOrigin','function producerOrigin','createOpId']),('apps/web/src/offline/sync-mutation-plan.ts',['producer.create','author.directories']),('apps/web/src/AuthorPage.vue',['addTestid:','formTestid:','data-set-rating','linkEntry','function saveAuthor'])]:
 ls=(R/p).read_text().splitlines();print('\nFILE',p)
 hits=set()
 for i,l in enumerate(ls):
  if any(t in l for t in terms):hits.update(range(max(0,i-5),min(len(ls),i+15)))
 print('\n'.join(f'{i+1}|{ls[i]}' for i in sorted(hits)))
