(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('t3-offline');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
 const ob=await new Promise(res=>{const r=db.transaction('outbox').objectStore('outbox').getAll();r.onsuccess=()=>res(r.result)});
 const rows=ob.map(r=>{const w=typeof r==='string'?JSON.parse(r):r;const op=w.operation||w;return {k:op.operationKind,s:op.status,at:op.lastAttemptAt?1:0}});
 const attempted=rows.filter(r=>r.at).length;
 const byKind={};for(const r of rows){const key=r.k+'|'+(r.at?'attempted':'never');byKind[key]=(byKind[key]||0)+1;}
 return JSON.stringify({n:rows.length,attempted,byKind})})()
