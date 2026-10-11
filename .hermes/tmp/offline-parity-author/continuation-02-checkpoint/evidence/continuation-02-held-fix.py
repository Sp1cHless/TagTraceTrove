from guard import edit
p='apps/web/src/offline/sync-mutation-plan.ts'
edit(p,"""export function referencedEntityKeys(operation: SyncReplayRequest): string[] {
""","""export function referencedEntityKeys(operation: SyncReplayRequest): string[] {
 if(operation.operationKind==='entry.authors.set')return [...new Set([...operation.baseValues.producerUids,...operation.payload.producerUids])].map(uid=>`producer:${uid.toLowerCase()}`);
 if(operation.operationKind==='entry.author.create-and-link')return [...new Set([...operation.baseValues.producerUids,operation.payload.producerUid])].map(uid=>`producer:${uid.toLowerCase()}`);
""")
edit(p,"(operation.operationKind==='entry.delete' && referencedEntityKeys(op)","((operation.operationKind==='entry.delete' || operation.operationKind==='producer.delete') && referencedEntityKeys(op)")
