(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('t3-offline');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
 const mo=await new Promise(res=>{const r=db.transaction('mediaOutbox').objectStore('mediaOutbox').getAll();r.onsuccess=()=>res(r.result)});
 const rows=mo.map(r=>{const w=typeof r==='string'?JSON.parse(r):r;return {k:w.kind,s:w.status,at:w.lastAttemptAt?1:0,u:String(w.entryUid).slice(0,8),o:w.ordinal,existing:!!w.existingEntry,bytes:w.byteLength}});
 return JSON.stringify({n:rows.length,rows})})()
