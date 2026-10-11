from pathlib import Path
R=Path('D:/Project/TagTraceTrove')
for p,ranges in [('apps/web/src/GalleryApp.vue',[(3170,3240),(3815,3855)]),('apps/web/src/offline/offline-api.ts',[(650,700),(1800,2045),(2385,2455),(5210,5245)]),('apps/web/src/AuthorPage.vue',[(1580,1625),(1648,1687),(1700,1745),(1780,1815)]),('apps/server/src/sync/replay-service.ts',[(1,1)])]:
 lines=(R/p).read_text().splitlines();print('\nFILE',p)
 for a,b in ranges: print('\n'.join(f'{i+1}|{lines[i]}' for i in range(a-1,min(b,len(lines)))))
