(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
 const b=[...document.querySelectorAll('button.gallery-link')].find(e=>(e.textContent||'').includes('探店'));
 if(b){b.click();await wait(1600);}
 const cards=[...document.querySelectorAll('[data-entry-id]')].map(e=>e.getAttribute('data-entry-id')+':'+(e.textContent||'').trim().slice(0,10));
 return JSON.stringify({cards,body:(document.body.innerText||'').slice(0,300)})})()
