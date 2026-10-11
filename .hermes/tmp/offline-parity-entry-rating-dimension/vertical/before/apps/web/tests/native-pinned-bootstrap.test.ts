import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { createApiClient, ApiError } from '../src/api/client.js';
function bootstrap(nativePromise: (plugin: string, method: string, args: Record<string, unknown>) => Promise<unknown>) {
 const source = readFileSync(new URL('../../../spikes/001-android-webview-shell/prepare-web.mjs',import.meta.url),'utf8');
 const script = source.match(/<script>([\s\S]*?)<\/script>/)![1]!;
 const originalFetch = vi.fn<typeof fetch>(async()=>Response.json({external:true}));
 const window = {fetch:originalFetch,Capacitor:{nativePromise},addEventListener:vi.fn()};
 runInNewContext(script,{window,Request,Response,URL,Uint8Array,DOMException,TypeError,location:{href:'https://localhost/'},btoa,atob});
 return {window,originalFetch};
}
it('actual prepared native bootstrap carries typed API JSON and multipart through the bridge without JS authorization and preserves final media URL',async()=>{
 const native = vi.fn<(plugin: string, method: string, args: Record<string, unknown>) => Promise<{status:number;contentType:string;body:string;url:string}>>(async()=>({status:200,contentType:'application/json',body:btoa(JSON.stringify({ok:true})),url:'https://localhost/api/assets/entries/1/cover.webp'}));
 const {window,originalFetch}=bootstrap(native);
 const api=createApiClient({baseUrl:'https://localhost/api/',fetchImplementation:window.fetch as typeof fetch});
 await expect(api.request('entries/1',{method:'PATCH',body:{title:'Native'}})).resolves.toEqual({ok:true});
 const args=native.mock.calls[0]![2] as unknown as {path:string;body:string;method:string};
 expect(args.path).toBe('/api/entries/1');expect(args.method).toBe('PATCH');expect(JSON.parse(atob(args.body))).toEqual({title:'Native'});
 expect(JSON.stringify(args)).not.toMatch(/authorization|Bearer|token/);
 const response=await window.fetch('https://localhost/api/thumbnails/entries/1/cover.webp');expect(response.url).toBe('https://localhost/api/assets/entries/1/cover.webp');
 await window.fetch('https://external.test/source');expect(originalFetch).toHaveBeenCalledOnce();expect(native).toHaveBeenCalledTimes(2);
 const form=new FormData();form.append('title','upload');await api.request('entries/1/media',{method:'POST',formData:form});
 expect(atob((native.mock.calls[2]![2] as unknown as {body:string}).body)).toContain('upload');
});
it('network failure supports existing offline fallback but TLS/auth rejection remains an authoritative 401',async()=>{
 const native=vi.fn(async()=>{throw Object.assign(new Error('Rejected'),{code:'PAIRING_REJECTED'});});
 const {window}=bootstrap(native);const api=createApiClient({baseUrl:'https://localhost/api/',fetchImplementation:window.fetch as typeof fetch});
 await expect(api.request('sync/capabilities')).rejects.toBeInstanceOf(ApiError);
 native.mockImplementation(async()=>{throw Object.assign(new Error('Unavailable'),{code:'NETWORK_UNAVAILABLE'});});
 await expect(api.request('sync/capabilities')).rejects.toBeInstanceOf(TypeError);
});
