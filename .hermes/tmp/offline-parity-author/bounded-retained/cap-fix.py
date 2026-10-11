from run import edit,gate
edit('apps/web/src/offline/offline-api.ts',"throw new Error('Refresh this offline copy to enable Author deletion');","throw new Error(isOnlineMode() ? 'Refresh this offline copy to enable Author deletion' : 'Author deletion is not available under offline');")
gate('cap-green',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','--maxWorkers','2','--testTimeout','30000','-t','known offline Author delete refuses'])
