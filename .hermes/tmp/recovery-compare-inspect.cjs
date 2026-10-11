const fs=require('fs'),ts=require('typescript');
const srcPath='.hermes/tmp/recovery2-snapshot-candidate.ts',bunPath='apps/web/dist/assets/index-B5YHEFQj.js';
const src=fs.readFileSync(srcPath,'utf8'),bun=fs.readFileSync(bunPath,'utf8');
const sf=ts.createSourceFile(srcPath,src,ts.ScriptTarget.Latest,true),bf=ts.createSourceFile(bunPath,bun,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
let so,bo;function walk(n,fn){fn(n);ts.forEachChild(n,c=>walk(c,fn));}walk(sf,n=>{if(ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(sf)==='assignEntryTag'))so=n});walk(bf,n=>{if(ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(bf)==='assignEntryTag')&&n.getStart(bf)<690194&&n.end>690194)bo=n});
console.log('objects',so?.properties.length,bo?.properties.length,bo?.getStart(bf));
function extract(o,file,text){return o.properties.filter(p=>p.body).map(p=>({name:p.name.getText(file),start:p.getStart(file),end:p.end,line:file.getLineAndCharacterOfPosition(p.getStart(file)).line+1,params:p.parameters.length,text:p.getText(file),literals:(()=>{let a=[];walk(p,n=>{if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isNumericLiteral(n))a.push(n.text)});return a})()}))}
const sm=extract(so,sf,src),bm=extract(bo,bf,bun);
let report=[];for(const s of sm){let b=bm.find(x=>x.name===s.name);if(!b){report.push({name:s.name,only:'source'});continue}let sl=new Set(s.literals),bl=new Set(b.literals);report.push({name:s.name,line:s.line,bundleOffset:b.start,params:[s.params,b.params],onlySource:[...sl].filter(x=>!bl.has(x)),onlyBundle:[...bl].filter(x=>!sl.has(x)),length:[s.text.length,b.text.length]})}
fs.writeFileSync('.hermes/tmp/recovery-compare-methods.json',JSON.stringify({source:sm,bundle:bm,report},null,2));console.log(JSON.stringify(report,null,2));
fs.writeFileSync('.hermes/tmp/recovery-compare-bundle-facade.js',bo.getText(bf));
let funcs=[];walk(bf,n=>{if(ts.isFunctionDeclaration(n)&&n.getStart(bf)>570000&&n.getStart(bf)<bo.getStart(bf))funcs.push({name:n.name?.text,start:n.getStart(bf),end:n.end,text:n.getText(bf)})});fs.writeFileSync('.hermes/tmp/recovery-compare-bundle-helpers.json',JSON.stringify(funcs,null,2));
