(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
 document.querySelector('[data-testid=media-edit-toggle]').click();await wait(1500);
 const t=document.body.innerText||'';
 const btns=[...document.querySelectorAll('[data-testid^=media-]')].map(e=>({t:e.getAttribute('data-testid'),d:e.disabled,aria:e.getAttribute('aria-label')}));
 const hints=[...document.querySelectorAll('p,small,span,div')].map(e=>(e.textContent||'').trim()).filter(x=>/uncertain|attempt|更新|Update|同步/i.test(x)&&x.length<120).slice(0,6);
 return JSON.stringify({mediaButtons:btns,hints,errs:[...document.querySelectorAll('[role=alert],.error-message')].map(e=>(e.textContent||'').trim().slice(0,120))})})()
