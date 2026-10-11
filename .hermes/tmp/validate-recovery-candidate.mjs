import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const candidate = resolve(process.argv[2]);
const target = resolve('apps/web/src/offline/offline-api.ts');
const configPath = resolve('apps/web/tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('apps/web'));
const host = ts.createCompilerHost(parsed.options);
const originalRead = host.readFile.bind(host);
const content = readFileSync(candidate, 'utf8');
host.readFile = file => resolve(file).toLowerCase() === target.toLowerCase() ? content : originalRead(file);
const program = ts.createProgram(parsed.fileNames.filter(file => !file.endsWith('.vue')), { ...parsed.options, noEmit: true }, host);
const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file && resolve(diagnostic.file.fileName).toLowerCase() === target.toLowerCase());
for (const d of diagnostics) {
 const point = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
 console.log(`${point.line + 1}:${point.character + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}
console.log(JSON.stringify({ candidate, target, sourceLines: content.split('\n').length, targetDiagnostics: diagnostics.length, note: 'Virtual compiler input only; no production write and not full Vue workspace typecheck' }));
process.exitCode = diagnostics.length ? 1 : 0;
