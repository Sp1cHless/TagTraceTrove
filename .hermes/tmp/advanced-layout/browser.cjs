const {chromium}=require('C:/Users/hzy/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true}); const results=[];
for(const locale of ['en','zh'])for(const width of [360,390,430,768,1440]){
const page=await browser.newPage({viewport:{width,height:1000}}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(`http://127.0.0.1:18744/?locale=${locale}`); await page.waitForSelector('[data-testid=settings-button]');
// Real shell settings caller, never bare component.

await page.locator('[data-testid="settings-button"]').click();
await page.locator('[data-testid="advanced-entry"]').click();
for(const tab of ['tags','sources','offline']){
await page.locator(`[data-testid="advanced-tab-${tab}"]`).click();
if(tab==='tags'){for(const name of ['tagMergeKept','tagMergeMerged','tagDeletePick']){await page.locator('input[name='+name+']').fill('Long');await page.locator('.suggestion-input__option').first().click();}await page.locator('[data-testid="taxonomy-group-pending"]').click();await page.locator('[data-testid="taxonomy-group-mapped"]').click();await page.locator('[data-testid="taxonomy-fill-1"]').click();}
if(tab==='sources'){await page.locator('input[name="sm-origin-source"]').check();await page.locator('[data-testid="sm-target-homepage"]').fill('https://fixture.invalid/long');await page.locator('.sm-target button.secondary-button').click();await page.locator('[data-testid="sm-start"]').click();await page.waitForSelector('[data-testid="sm-review"]');await page.locator('.sm-item-actions input').fill('https://fixture.invalid/manual');}
if(tab==='offline'){await page.locator('[data-testid="offline-media-mode"]').selectOption('selected-originals');await page.locator('[data-testid="offline-selected-originals"]').fill('long-asset-ref'.repeat(30));await page.locator('[data-testid="native-transfer-resume"]').click();await page.locator('[data-testid="offline-restore-file"]').setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from('{}')});}
await page.waitForTimeout(100);
const data=await page.evaluate(()=>{const card=document.querySelector('.advanced-card');const r=card.getBoundingClientRect();const cs=getComputedStyle(card);const bounds={left:r.left+parseFloat(cs.paddingLeft)+parseFloat(cs.borderLeftWidth),right:r.right-parseFloat(cs.paddingRight)-parseFloat(cs.borderRightWidth)};const failures=[];let controls=0,textRects=0;
for(const el of card.querySelectorAll('*')){if(!el.getClientRects().length)continue;if(el.matches('button,input,select,textarea')){controls++;const b=el.getBoundingClientRect();if(b.left<bounds.left-1||b.right>bounds.right+1)failures.push({kind:'control',tag:el.tagName,id:el.dataset.testid||el.getAttribute('name'),left:b.left,right:b.right});}
for(const n of el.childNodes){if(n.nodeType!==3||!n.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(n);for(const b of range.getClientRects()){textRects++;if(b.left<bounds.left-1||b.right>bounds.right+1)failures.push({kind:'text',text:n.textContent.trim().slice(0,70),left:b.left,right:b.right});}}}
return {width:innerWidth,card:{left:r.left,right:r.right},bounds,controls,textRects,failures};});
results.push({locale,tab,...data,errors}); fs.writeFileSync('.hermes/tmp/advanced-layout/'+process.argv[2]+'.json',JSON.stringify(results,null,2));await page.screenshot({path:`.hermes/tmp/advanced-layout/${process.argv[2]}-${locale}-${width}-${tab}.png`,fullPage:true}); console.log(locale,width,tab,data.failures.length);
}await page.close();}
fs.writeFileSync(`.hermes/tmp/advanced-layout/${process.argv[2]}.json`,JSON.stringify(results,null,2));await browser.close();if(process.argv[2]!=='red'&&results.some(r=>r.failures.length||r.errors.length))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
