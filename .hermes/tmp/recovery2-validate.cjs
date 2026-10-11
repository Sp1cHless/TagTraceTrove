const fs=require('fs'),ts=require('typescript'),path=require('path');
const root='D:/Project/TagTraceTrove'; const candidate=path.resolve(root,'.hermes/tmp/recovery2-snapshot-candidate.ts');const target=path.resolve(root,'apps/web/src/offline/offline-api.ts');
const cfg=ts.readConfigFile(path.resolve(root,'apps/web/tsconfig.json'),ts.sys.readFile);const config=ts.parseJsonConfigFileContent(cfg.config,ts.sys,path.resolve(root,'apps/web'));
config.options.noEmit=true;const host=ts.createCompilerHost(config.options);const orig=host.readFile;host.readFile=(p)=>path.resolve(p).toLowerCase()===target.toLowerCase()?fs.readFileSync(candidate,'utf8'):orig(p);
const program=ts.createProgram(config.fileNames,config.options,host);const f=program.getSourceFile(target); const ds=ts.getPreEmitDiagnostics(program).filter(d=>d.file&&path.resolve(d.file.fileName).toLowerCase()===target.toLowerCase());
const report={candidate,syntax:f.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')),diagnostics:ds.map(d=>({line:d.file.getLineAndCharacterOfPosition(d.start??0).line+1,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}))};
fs.writeFileSync(path.resolve(root,'.hermes/tmp/recovery2-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
