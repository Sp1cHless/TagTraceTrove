import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { expect, it } from 'vitest';
import { startSecurePairingListener } from '../../src/http/secure-pairing.js';

it('expires exactly, has one concurrent winner, persists only hashes, rejects all anonymous routes and hostile Origin, and fails closed on identity/config changes', async () => {
 const directory = await mkdtemp(join(tmpdir(),'t3-auth-security-'));
 let now = 1000; let libraryId = 'library';
 const options = {configDirectory: directory, libraryId, currentLibraryId: () => libraryId, advertisedHost:'192.168.1.2', hostname:'127.0.0.1', port:0, now:()=>now, fetch:()=>Response.json({ok:true})};
 let runtime = await startSecurePairingListener(options);
 const call = (path: string, body?: unknown, token?: string, headers: Record<string,string> = {}) => new Promise<{status:number; body:Record<string,unknown>}>((resolve,reject) => {
  const req = request(runtime.testOrigin+path,{ca:runtime.certificate,method:body === undefined?'GET':'POST',headers:{...(body === undefined?{}:{'content-type':'application/json'}),...(token?{authorization:`Bearer ${token}`} :{}),...headers}},res=>{let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(text) as Record<string,unknown>}));});req.on('error',reject);req.end(body === undefined?undefined:JSON.stringify(body));
 });
 const claim = (code:string) => ({code, libraryId:'library', protocolVersion:1, deviceName:'Phone'});
 try {
  await expect(startSecurePairingListener(options)).rejects.toThrow('live owner');
  const expired = runtime.issue(); now = expired.expiresAt;
  expect((await call('/api/pairing/claim',claim(expired.code))).status).toBe(401);
  const offer = runtime.issue();
  const claims = await Promise.all([call('/api/pairing/claim',claim(offer.code)),call('/api/pairing/claim',claim(offer.code))]);
  expect(claims.map(result=>result.status).sort()).toEqual([201,401]);
  const winner = claims.find(result=>result.status===201)!; const token = winner.body.token as string;
  const bytes = await readFile(join(directory,'authorization.json'),'utf8');
  expect(bytes.includes(token)).toBe(false); expect(bytes.includes(offer.code)).toBe(false);
  for (const path of ['/api/assets/entries/1/cover.webp','/api/thumbnails/entries/1/cover.webp','/api/sync/capabilities','/api/sync/snapshot','/api/sync/replay','/api/entries','/api/pairing/offer']) expect((await call(path)).status).toBe(401);
  expect((await call('/api/entries',undefined,token,{origin:'https://evil.test'})).status).toBe(403);
  expect((await call('/api/entries',undefined,token,{cookie:'session=bad'})).status).toBe(403);
  expect((await call('/api/pairing/offer',{},token)).status).toBe(403);
  await runtime.close(); runtime = await startSecurePairingListener(options);
  expect((await call('/api/entries',undefined,token)).status).toBe(200);
  libraryId='changed'; expect((await call('/api/entries',undefined,token)).status).toBe(401); expect(()=>runtime.issue()).toThrow('identity changed'); libraryId='library';
  runtime.revoke(winner.body.deviceId as string); await runtime.close(); runtime = await startSecurePairingListener(options);
  expect((await call('/api/entries',undefined,token)).status).toBe(401);
  await runtime.close();
  await expect(startSecurePairingListener({...options,libraryId:'other'})).rejects.toThrow('identity changed');
  await writeFile(join(directory,'authorization.json'),'{}');
  await expect(startSecurePairingListener(options)).rejects.toThrow();
 } finally { await runtime.close(); await rm(directory,{recursive:true,force:true}); }
});
