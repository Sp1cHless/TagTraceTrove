from guard import edit
edit('apps/web/tests/offline-author-parity.integration.test.ts','await f.current.setProducerViewLater(f.author.id,true);','await f.current.addViewLaterAuthor(f.author.id);')
