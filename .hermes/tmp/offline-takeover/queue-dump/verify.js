(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
 const b=[...document.querySelectorAll('button.gallery-link')].find(e=>(e.textContent||'').includes('探店'));
 if(b){b.click();await wait(1600);}
 const card=[...document.querySelectorAll('[data-entry-id]')].find(e=>(e.textContent||'').includes('测试2'));
 card.click();await wait(1600);
 document.querySelector('[data-testid=start-entry-editing]').click();await wait(1200);
 const toggle=document.querySelector('[data-testid=media-edit-toggle]');
 if(toggle)toggle.click();await wait(1500);
 const reason=document.querySelector('[data-testid=media-removal-reason]');
 const del=document.querySelector('[data-testid=media-delete]');
 return JSON.stringify({bundle:(document.querySelector('script[src*=index-]')||{}).src,reason:reason?reason.textContent:null,deleteDisabled:del?del.disabled:null})})()
