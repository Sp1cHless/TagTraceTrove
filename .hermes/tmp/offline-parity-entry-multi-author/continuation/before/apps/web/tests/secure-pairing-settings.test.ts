// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import SecurePairingSettings from '../src/components/SecurePairingSettings.vue';
afterEach(()=>vi.unstubAllGlobals());
it('issues and displays actual server SVG/payload then revokes through protected desktop routes',async()=>{
 const calls: {path:string; options?:RequestInit}[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{
  calls.push({path,...(options?{options}: {})});
  if(path.endsWith('/status')) return Response.json({csrf:'test-csrf',devices:[{deviceId:'device',deviceName:'Phone',revoked:false}]});
  if(path.endsWith('/offer')) return Response.json({svg:'<svg xmlns="http://www.w3.org/2000/svg"/>',payload:{version:1,endpoint:'https://192.168.1.2:8766'}});
  return Response.json({devices:[{deviceId:'device',deviceName:'Phone',revoked:true}]});
 }));
 const wrapper=mount(SecurePairingSettings);
 await wrapper.findAll('button')[0]!.trigger('click');await flushPromises();
 expect(wrapper.get('img').attributes('src')).toContain('data:image/svg+xml');
 expect(wrapper.get('textarea').element.value).toContain('https://192.168.1.2:8766');
 expect(calls[1]!.options?.headers).toMatchObject({'x-t3-csrf':'test-csrf'});
 await wrapper.findAll('button').find(button=>button.text()==='Revoke device')!.trigger('click');await flushPromises();
 expect(wrapper.text()).toContain('revoked');
 expect(calls.at(-1)!.options?.body).toBe(JSON.stringify({deviceId:'device'}));
 wrapper.unmount();
});
it('requires typed library identity and owner PID before explicit recovery without clearing offline work', async () => {
 const calls: string[] = [];
 vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
  if (path.endsWith('/status')) return Response.json({ csrf: 'csrf', devices: [], recovery: { libraryId: 'library', message: 'stale lock' } });
  calls.push(options?.body as string); return Response.json({ recovered: true });
 }));
 const wrapper = mount(SecurePairingSettings);
 await wrapper.findAll('button').find(button => button.text() === 'Authorized devices')!.trigger('click'); await flushPromises();
 expect(wrapper.find('[data-testid="pairing-recovery"]').exists()).toBe(true);
 expect(wrapper.get('[data-testid="recover-lock"]').attributes('disabled')).toBeDefined();
 await wrapper.get('[data-testid="confirm-library"]').setValue('library');
 await wrapper.get('[data-testid="confirm-owner"]').setValue('123');
 await wrapper.get('[data-testid="recover-lock"]').trigger('click'); await flushPromises();
 expect(calls).toEqual([JSON.stringify({ libraryId: 'library', ownerPid: 123, action: 'recover-lock' })]);
 expect(wrapper.text()).toContain('offline copy and queued edits'); wrapper.unmount();
});
