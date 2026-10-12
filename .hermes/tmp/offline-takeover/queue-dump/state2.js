(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));await wait(6000);
 const db=await new Promise((res,rej)=>{const r=indexedDB.open('t3-offline');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
 const ob=await new Promise(res=>{const r=db.transaction('outbox').objectStore('outbox').getAll();r.onsuccess=()=>res(r.result)});
 const rows=ob.map(r=>{const w=typeof r==='string'?JSON.parse(r):r;const op=w.operation||w;return {k:op.operationKind,s:op.status,e:op.lastError?String(op.lastError).slice(0,60):null}});
 const byStatus={},byKindFailed={};for(const r of rows){byStatus[r.s]=(byStatus[r.s]||0)+1;if(r.s!=='pending')byKindFailed[r.k+':'+r.s]=(byKindFailed[r.k+':'+r.s]||0)+1;}
 const t=document.querySelector('[data-testid=offline-diagnostics-toggle]');
 return JSON.stringify({n:rows.length,byStatus,byKindFailed,replayErr:(document.body.innerText||'').match(/An offline edit conflicts[^\n]*/)?.[0]??null})})()
