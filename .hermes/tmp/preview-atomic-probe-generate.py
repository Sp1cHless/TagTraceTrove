from pathlib import Path
s=Path('apps/web/tests/existing-entry-media-vertical.test.ts').read_text(encoding='utf8')
s=s.split("describe('existing Entry real cold client/server media vertical'")[0]
s=s.replace('../../server/node_modules/','../../apps/server/node_modules/').replace('../../server/src/','../../apps/server/src/').replace('../src/','../../apps/web/src/')
s += '''
describe('same Entry concurrent local edits',()=>{
 it('refuses or refreshes an upload reviewed before a queued local deletion',async()=>{
  const h=await harness();let release!:()=>void;
  try {
   const colors=['#ef3030','#3030ef'];
   for(const color of colors){const bytes=await sharp({create:{width:3,height:3,channels:3,background:color}}).png().toBuffer();await h.online.uploadEntryMedia(h.entry.id,'preview',new File([bytes],'seed.png',{type:'image/png'}) as unknown as globalThis.File);}
   const active=await readActiveSnapshot(h.store);
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:active});
   const before=await h.api.getEntry(h.entry.id);
   expect(before.previewRefs).toHaveLength(2);
   const file=h.file();const original=file.arrayBuffer.bind(file);
   let entered!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
   Object.defineProperty(file,'arrayBuffer',{value:async()=>{entered();await gate;return original();}});
   const staged=h.api.uploadEntryMedia(h.entry.id,'preview',file).then(value=>({value,error:null}),error=>({value:null,error}));
   await enteredPromise;
   await h.api.setEntryMediaOrder!(h.entry.id,[before.previewRefs[0]!]);
   expect(await h.store.list()).toHaveLength(1);
   release();const result=await staged;
   const media=await h.store.listMedia();
   console.log('concurrent local edit observation',JSON.stringify({error:result.error?String(result.error):null,originalReviewedRefs:before.previewRefs,staged:media.map(row=>({ordinal:row.ordinal,existingEntry:row.existingEntry}))}));
   if(result.error){expect(String(result.error)).toMatch(/changed|review|capture|queue|stale/iu);expect(media).toEqual([]);}
   else {expect(media).toHaveLength(1);expect(media[0]!.existingEntry!.expectedPreviewRefs).toEqual([before.previewRefs[0]!]);expect(media[0]!.ordinal).toBe(1);}
  } finally {release?.();await h.cleanup();}
 },30000);
});
'''
Path('.hermes/tmp/preview-atomic-probe.test.ts').write_text(s,encoding='utf8')
