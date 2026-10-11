from pathlib import Path
import hashlib,json
p=Path('apps/web/tests/quick-author-ui.integration.test.ts');base=Path('.hermes/tmp/quick-author-safe');m=json.loads((base/'working.json').read_text());b=p.read_bytes();assert hashlib.sha256(b).hexdigest()==m[p.as_posix()]
q=base/'continuation-start'/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
def replace(old,new):
 global b
 old=old.encode();new=new.encode();assert b.count(old)==1,old[:100];b=b.replace(old,new)
replace("import { setLocale } from '../src/i18n.js';", "import { setLocale } from '../src/i18n.js';\nimport { createNavigationMemory, navigationMemoryKey } from '../src/navigation-memory.js';")
replace("async function setup(offline = true) {", "async function setup(offline = true, loss: 'replay' | 'snapshot' | 'ack' = 'replay') {")
replace("  const { buildSyncSnapshot } = await serverModule('sync/sync-service');\n", "")
replace("if(url.pathname==='/api/sync/replay'){bodies.push(String(init?.body));if(lose&&response.ok){lose=false;available=false;throw new TypeError('committed response lost');}}", "if(url.pathname==='/api/sync/replay') bodies.push(String(init?.body));\n    const loseHere = loss === 'replay' ? url.pathname === '/api/sync/replay' : loss === 'ack' ? url.pathname.includes('/ack') : bodies.length > 0 && (url.pathname.includes('/snapshot') || url.pathname.includes('/delta'));\n    if(lose && loseHere && response.ok){lose=false;available=false;throw new TypeError(`${loss} response lost`);}")
replace("JSON.stringify(buildSyncSnapshot(db))", "JSON.stringify(await online.fetchSyncSnapshot())")
replace("return {db,root,self,author,bodies,reconnect()", "return {db,root,self,author,bodies,online,reconnect()")
replace("['13:25',805,false]] as const)", "['13:25',805,false],['0',0,false],['',null,false]] as const)")
extra=r'''
// Real caller results are checked against application HTTP/SQLite, not a raw API stub.
async function authorFixture() {
  const f = await setup();
  const { createEntry } = await serverModule('repositories/entry-repository');
  const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
  const { createProducerRatingSlot, setProducerRating } = await serverModule('repositories/rating-repository');
  const { assignProducerTag } = await serverModule('repositories/producer-tag-repository');
  const { assignEntryTag } = await serverModule('repositories/entry-tag-repository');
  const { createSection } = await serverModule('repositories/layout-repository');
  const authors = [f.author, ...['Alpha', 'Beta', 'Null'].map(name => createProducer(f.db, {name}))];
  const section = createSection(f.db, {entryType:'comic', name:'Genre'});
  const second = createProducerRatingSlot(f.db, {producerId:f.author.id, name:'Second', kind:'author_self'});
  let own = 0, work = 0;
  for (const [i, author] of authors.entries()) {
    const entry = createEntry(f.db, {title:`Work ${i}`, type:'comic'});
    linkEntryProducer(f.db, entry.id, author.id);
    if (i < 2) own = assignProducerTag(f.db, {producerId:author.id, name:'Circle'}).tagId;
    if (i === 0 || i === 2) work = assignEntryTag(f.db, {entryId:entry.id, facetId:section.defaultFacetId, name:'Action'}).tagId;
    if (i < 3) {
      setProducerRating(f.db, {producerId:author.id, slotId:f.self.id, stars:[5,4,3.5][i]});
      setProducerRating(f.db, {producerId:author.id, slotId:second.id, stars:[3.5,5,4][i]});
    }
  }
  f.reconnect();
  await f.store.writeGeneration(2, JSON.stringify(await f.online.fetchSyncSnapshot()));
  await f.store.writeMeta('activeGeneration','2');
  await f.reopen();
  return {f, authors, second, own, work};
}
const ids = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-author-id]').map(row=>Number(row.attributes('data-author-id')));
async function checkSql(f: Awaited<ReturnType<typeof setup>>, wrapper: ReturnType<typeof mount>, query: ReturnType<typeof vi.spyOn>) {
  await settle();
  const call = query.mock.calls.at(-1)!;
  const sql = await f.online.queryProducerPage(call[0]);
  const actual = await query.mock.results.at(-1)!.value;
  expect(actual.items.map((row:{id:number})=>row.id)).toEqual(sql.items.map(row=>row.id));
  expect(actual.total).toBe(sql.total);
  expect(ids(wrapper)).toEqual(sql.items.map(row=>row.id));
  expect(wrapper.get('[data-testid="author-list-count"]').text()).toContain(String(sql.total));
  return sql;
}
it('actual Author own/work tags AND rating agree with SQL and restore rows/results after navigation unmount', async()=>{
  const {f, authors} = await authorFixture();
  const memory = createNavigationMemory();
  const query = vi.spyOn(f.api,'queryProducerPage');
  const options = {props:{api:f.api, authors:await f.api.listAuthors()}, global:{provide:{[navigationMemoryKey as symbol]:memory}}};
  let wrapper = mount(AuthorPage, options);
  try {
    await settle();
    for (const prefix of ['author','work']) {
      await wrapper.get(`[data-testid="add-${prefix}-tag-filter"]`).trigger('click');
      await wrapper.get(`[data-testid="${prefix}-tag-combobox-toggle"]`).trigger('click');
      await wrapper.get(`[data-testid="${prefix}-tag-combobox-option"]`).trigger('click');
      await settle();
    }
    await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');
    await wrapper.get('[data-testid="author-rating-slot-select"]').setValue(f.self.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[0].id]);
    const savedIds = ids(wrapper);
    wrapper.unmount();
    expect(memory.states.get('author-list')).toMatchObject({ratingFilters:[{slotId:f.self.id,operator:'gt',stars:3}]});
    wrapper = mount(AuthorPage, options);
    await settle();
    expect((wrapper.get('[data-testid="author-rating-slot-select"]').element as HTMLSelectElement).value).toBe(String(f.self.id));
    expect((wrapper.get('[data-testid="author-rating-operator-select"]').element as HTMLSelectElement).value).toBe('gt');
    expect((wrapper.get('[data-testid="author-rating-stars-select"]').element as HTMLSelectElement).value).toBe('3');
    expect(wrapper.get('[data-testid="author-tag-combobox-toggle"]').text()).toContain('Circle');
    expect(wrapper.get('[data-testid="work-tag-combobox-toggle"]').text()).toContain('Action');
    await checkSql(f,wrapper,query);expect(ids(wrapper)).toEqual(savedIds);
  } finally {wrapper.unmount();f.close();}
});
it('actual multi-row first selected slot controls order; replacement/deletion/operators/reset preserve SQL totals', async()=>{
  const {f, authors, second} = await authorFixture();
  const query = vi.spyOn(f.api,'queryProducerPage');
  const wrapper = mount(AuthorPage,{props:{api:f.api,authors:await f.api.listAuthors()}});
  const rows = () => wrapper.findAll('[data-testid="author-rating-filter-row"]');
  try {
    await settle();
    // An empty first row must not steal sorting from the first selected row.
    await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');
    await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');
    await rows()[1]!.get('[data-testid="author-rating-slot-select"]').setValue(second.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[1].id,authors[2].id,authors[0].id]);
    await rows()[0]!.get('[data-testid="author-rating-slot-select"]').setValue(f.self.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[0].id,authors[1].id,authors[2].id]);
    await rows()[0]!.get('[data-testid="author-rating-slot-select"]').setValue(second.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[1].id,authors[2].id,authors[0].id]);
    await rows()[0]!.get('[data-testid="remove-author-rating-filter"]').trigger('click');
    expect((await checkSql(f,wrapper,query)).total).toBe(3);
    await rows()[0]!.get('[data-testid="author-rating-operator-select"]').setValue('lt');
    expect((await checkSql(f,wrapper,query)).total).toBe(0);
    await rows()[0]!.get('[data-testid="author-rating-operator-select"]').setValue('eq');
    await rows()[0]!.get('[data-testid="author-rating-stars-select"]').setValue('4');
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[2].id]);
    await rows()[0]!.get('[data-testid="author-rating-operator-select"]').setValue('unrated');
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[3].id]);
    await rows()[0]!.get('[data-testid="remove-author-rating-filter"]').trigger('click');
    const reset = await checkSql(f,wrapper,query);expect(reset.total).toBe(4);
    expect(reset.items.map(row=>row.name)).toEqual(['Alpha','Author','Beta','Null']);
  } finally {wrapper.unmount();f.close();}
});
it.each(['snapshot','ack'] as const)('actual Quick import retains committed create on %s response loss until cold exact retry settles',async loss=>{
  const f=await setup(true,loss);const wrapper=mount(GalleryApp,{props:{api:f.api}});
  try {
    await settle();await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');await settle();
    const form=wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue(`Lost ${loss}`);
    await form.get('input[name="duration"]').setValue('0');await form.trigger('submit');await settle();
    const before=await f.store.list();expect(before).toHaveLength(1);
    f.reconnect();await f.api.flushOfflineOutbox!();
    expect(f.db.prepare('SELECT duration_seconds FROM entries WHERE title=?').pluck().get(`Lost ${loss}`)).toBe(0);
    expect(await f.store.list()).toHaveLength(1);
    await f.reopen();
    const retained=(await f.store.list())[0]!;
    expect({opId:retained.opId,payload:retained.payload}).toEqual({opId:before[0]!.opId,payload:before[0]!.payload});
    expect(await f.api.listPendingOfflineEntryCreates!()).toHaveLength(1);
    f.reconnect();await f.api.flushOfflineOutbox!();expect(f.bodies).toHaveLength(2);expect(f.bodies[0]).toBe(f.bodies[1]);
    expect(await f.store.list()).toEqual([]);expect(await f.api.listPendingOfflineEntryCreates!()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) FROM entries WHERE title=?').pluck().get(`Lost ${loss}`)).toBe(1);
  } finally {wrapper.unmount();f.close();}
});
'''
b+=extra.encode();assert hashlib.sha256(p.read_bytes()).hexdigest()==m[p.as_posix()];p.write_bytes(b);m[p.as_posix()]=hashlib.sha256(b).hexdigest();(base/'working.json').write_text(json.dumps(m,indent=2));print('targeted guarded test edit',len(b),m[p.as_posix()])
