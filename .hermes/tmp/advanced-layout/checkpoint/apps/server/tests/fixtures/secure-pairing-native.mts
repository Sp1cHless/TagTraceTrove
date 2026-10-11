import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createTempFileDatabase, createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { startSecurePairingListener, privateHttpsHost, recoverSecurePairing } from '../../src/http/secure-pairing.js';
const address = Object.values(networkInterfaces()).flat().find(item => {
 if (!item || item.family !== 'IPv4' || item.internal) return false;
 try { privateHttpsHost(item.address); return true; } catch { return false; }
})?.address;
if (!address) throw new Error('No private IPv4 interface for actual native HTTPS fixture');
const directory = await mkdtemp(join(tmpdir(),'t3-native-tls-'));
const disposable=(process.env.T3_BACKGROUND_STANDALONE === '1' || process.env.T3_BACKGROUND_KINDS === '1' || process.env.T3_BACKGROUND_TWO === '1') ? createTempFileDatabase() : null;
const database = disposable?.database ?? createMigratedMemoryDatabase();
if(disposable)(await import('../../src/database/migrations.js')).applyAllMigrations(database);
const nativeUploads:Array<{uploadId:string;metadata:unknown;hash:string}> = [];let lostUpload=false;
const nativeReplayBodies:string[]=[];let lostReplay=false;
const assetRoot = join(directory,'assets');
await mkdir(join(assetRoot,'entries','1'),{recursive:true});
await writeFile(join(assetRoot,'entries','1','cover.webp'),Buffer.from('native-media-proof'));
const options = { configDirectory: join(directory,'auth'), libraryId: getSyncIdentity(database).libraryId,
 hostname: address, advertisedHost: address, fetch: async(request:Request) => {
   const path=new URL(request.url).pathname;let image: {kind:string;ordinal:number}|undefined;
   let operation:{operationKind:string}|undefined;
   if(path==='/api/sync/replay'){const body=await request.clone().text();nativeReplayBodies.push(body);operation=JSON.parse(body);}
   if(path.startsWith('/api/sync/media/')) {
     const form=await request.clone().formData();image=JSON.parse(String(form.get('metadata')));
     nativeUploads.push({uploadId:path.split('/').at(-1)!,metadata:image,hash:(await import('node:crypto')).createHash('sha256').update(Buffer.from(await (form.get('file') as Blob).arrayBuffer())).digest('hex')});
   }
   const response=await createApiApp(database,{assetRoot}).fetch(request);
   if(process.env.T3_BACKGROUND_KINDS==='1' && !lostReplay && operation?.operationKind==='entry.update' && response.ok){lostReplay=true;const bytes=new Uint8Array(await response.arrayBuffer());const stream=new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,Math.max(1,Math.floor(bytes.length/2))));setTimeout(()=>controller.error(new Error('Actual committed mutation response loss')),20);}});const headers=new Headers(response.headers);headers.set('content-length',String(bytes.length));return new Response(stream,{status:response.status,headers});}
   if(disposable && !lostUpload && image?.kind==='preview' && image.ordinal===0 && response.ok) {
     lostUpload=true;const bytes=new Uint8Array(await response.arrayBuffer());
     const stream=new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,Math.max(1,Math.floor(bytes.length/2))));setTimeout(()=>controller.error(new Error('Actual committed upload response loss')),20);}});
     const headers=new Headers(response.headers);headers.set('content-length',String(bytes.length));return new Response(stream,{status:response.status,headers});
   }
   return response;
 } };
let runtime = await startSecurePairingListener({...options,port:0});
const port = Number(new URL(runtime.endpoint).port);
const output = (value: unknown) => process.stdout.write(JSON.stringify(value)+'\n');
output(runtime.issue());
const { createServer: httpsServer } = await import('node:https');
const { createServer: httpServer } = await import('node:http');
let targetRequests = 0, targetAuthorization = 0, sourceAuthorization = 0;
const sentinel = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
 targetRequests++; if (request.headers.authorization) targetAuthorization++; response.end('sentinel');
};
const tlsOptions = { key: await readFile(join(options.configDirectory, 'tls-key.pem')), cert: runtime.certificate };
const tlsTarget = httpsServer(tlsOptions, sentinel), plainTarget = httpServer(sentinel);
const listen = (server: import('node:http').Server) => new Promise<void>(resolve => server.listen(0, address, resolve));
await listen(tlsTarget); await listen(plainTarget);
const originOf = (server: import('node:http').Server, scheme: string) => `${scheme}://${address}:${(server.address() as import('node:net').AddressInfo).port}`;
const redirectSource = httpsServer(tlsOptions, (request, response) => {
 if (request.headers.authorization) sourceAuthorization++;
 response.writeHead(302, { location: originOf(request.url?.includes('downgrade') ? plainTarget : tlsTarget, request.url?.includes('downgrade') ? 'http' : 'https') + '/api/sentinel' }); response.end();
});
await listen(redirectSource);
let vertical: Awaited<ReturnType<typeof import("./native-background-vertical.mjs").createVertical>> | undefined;
const lines = createInterface({input:process.stdin});
for await (const line of lines) {
 const command = JSON.parse(line) as { action: string; deviceId?: string };
 if (command.action === 'background-prepare') { vertical = await (await import('./native-background-vertical.mjs')).createVertical(database,createApiApp(database,{assetRoot})); output(vertical.payload); }
 else if (command.action === 'background-counters') { output({nativeUploads}); }
 else if (command.action === 'background-foreground') { output({...await vertical!.foreground(),nativeReplayBodies,nativeUploads,mediaReceiptCount:(database.prepare('SELECT COUNT(*) AS n FROM sync_media_upload_receipts').get() as {n:number}).n}); }
 else if (command.action === 'restart') { await runtime.close(); runtime = await startSecurePairingListener({...options,port}); output({ok:true}); }
 else if (command.action === 'redirect-origin') { output({ endpoint: originOf(redirectSource, 'https'), certificateSha256: new (await import('node:crypto')).X509Certificate(runtime.certificate).fingerprint256.replaceAll(':', '').toLowerCase() }); }
 else if (command.action === 'redirect-counters') { output({targetRequests,targetAuthorization,sourceAuthorization}); }
 else if (command.action === 'replace-certificate') {
  await runtime.close();
  recoverSecurePairing(options, { libraryId: options.libraryId, ownerPid: 0, action: 'reset-identity' });
  runtime = await startSecurePairingListener({...options,port}); output(runtime.issue());
 }
 else if (command.action === 'revoke') { runtime.revoke(command.deviceId!); output({ok:true}); }
 else if (command.action === 'close') break;
}
for (const server of [redirectSource, tlsTarget, plainTarget]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
vertical?.close(); await runtime.close(); if(disposable)disposable.cleanup();else database.close(); await rm(directory,{recursive:true,force:true});
