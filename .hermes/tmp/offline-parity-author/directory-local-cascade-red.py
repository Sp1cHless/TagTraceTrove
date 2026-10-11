from guard import edit
p='apps/web/tests/offline-author-parity.integration.test.ts'
edit(p,"expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(2);\n  f.connect();f.loseAck();await cold.flushOfflineOutbox!();", "expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(2);expect((await cold.queryEntryPage({...entryPageQueryRequestSchema.parse({entryType:'comic'}),producerDirectoryId:directory.id})).total).toBe(0);\n  f.connect();f.loseAck();await cold.flushOfflineOutbox!();")
