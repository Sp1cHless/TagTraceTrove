from run import edit,gate
edit('apps/web/src/offline/offline-api.ts','if (entryDeleteReceipts.size && !candidate.acknowledgement && online.fetchSnapshotDelta && online.ackSnapshotDelta) {','if ((entryDeleteReceipts.size || producerDeleteReceipts.size) && !candidate.acknowledgement && online.fetchSnapshotDelta && online.ackSnapshotDelta) {')
gate('connected-green',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','--maxWorkers','2','--testTimeout','30000','-t','bounded connected'])
