(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
 document.querySelector('[data-entry-id="7105"]').click();await wait(1600);
 document.querySelector('[data-testid=start-entry-editing]').click();await wait(1200);
 const t=document.body.innerText||'';
 const strip=[...document.querySelectorAll('button')].map(e=>(e.getAttribute('data-testid')||'')+':'+((e.textContent||'').trim().slice(0,14))).filter(x=>x.startsWith('media')||x.includes('图片')||x.includes('预览'));
 return JSON.stringify({tail:t.slice(0,400),mediaButtons:strip.slice(0,12)})})()
