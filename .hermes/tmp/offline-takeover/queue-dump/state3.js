(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('t3-offline');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
 const ob=await new Promise(res=>{const r=db.transaction('outbox').objectStore('outbox').getAll();r.onsuccess=()=>res(r.result)});
 const bad=ob.map(r=>{const w=typeof r==='string'?JSON.parse(r):r;const op=w.operation||w;return op}).filter(op=>op.status!=='pending').map(op=>({k:op.operationKind,u:String(op.entityUid).slice(0,8),b:op.baseVersion,e:op.lastError}));
 const t=document.querySelector('[data-testid=offline-diagnostics-toggle]');if(t&&!document.querySelector('pre')){t.click();await new Promise(r=>setTimeout(r,1500));}
 const el=[...document.querySelectorAll('pre,textarea')].map(e=>(e.value||e.textContent||'')).sort((a,b)=>b.length-a.length)[0]||'';
 const grab=(k,len)=>{const i=el.indexOf(k);return i<0?null:el.slice(i,i+(len||90)).replace(/\s+/g,' ');};
 return JSON.stringify({bad,mode:grab('"mode"',30),err:grab('lastReplayError',140),pending:grab('pendingCount',20)})})()
