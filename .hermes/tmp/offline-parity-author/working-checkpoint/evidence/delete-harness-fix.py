from guard import *
f='apps/web/tests/offline-author-parity.integration.test.ts'
edit(f,"const authors=wrapper.findAll('button').find(button=>button.text()==='Authors');expect(authors).toBeDefined();await authors!.trigger('click');", "await wrapper.get('.author-link').trigger('click');")
edit(f,"f.business.length=0;const button=wrapper.get('[data-testid=\"delete-author\"]');", "const edit=wrapper.findAll('button').find(button=>button.text()==='Edit');expect(edit).toBeDefined();await edit!.trigger('click');await settle();f.business.length=0;const button=wrapper.get('[data-testid=\"delete-author\"]');")
