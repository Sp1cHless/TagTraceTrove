from guard import ROOT
for p,terms in [('apps/web/src/GalleryApp.vue',['openCreation','addAuthor','create.author']),('apps/web/src/AuthorPage.vue',['defineProps','initialTarget','initialAuthor','authorId:','RatingPicker','setAuthorRating']),('apps/web/src/offline/offline-api.ts',['function producerVersionDelta'])]:
 ls=(ROOT/p).read_text().splitlines();print(p)
 for i,l in enumerate(ls):
  if any(t in l for t in terms):print('\n'.join(f'{j+1}|{ls[j]}' for j in range(max(0,i-2),min(len(ls),i+14))))
