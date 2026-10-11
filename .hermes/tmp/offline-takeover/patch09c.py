import io

path = r'D:\Project\TagTraceTrove\apps\web\src\offline\offline-api.ts'
text = io.open(path, encoding='utf-8').read()

# 1. Projections in snapshotWithOverlays (after the tag-layout.set hook).
old = """  const layoutIndex = operations.findIndex(row=>row.operationKind==='entry.tag-layout.set');
  if (layoutIndex >= 0) {
    const op = transportOperation(operations[layoutIndex]!);
    if (op.operationKind !== 'entry.tag-layout.set') throw new Error('Invalid tag layout');
    const prior = snapshotWithOverlays(snapshot,operations.slice(0,layoutIndex));
    return snapshotWithOverlays(applyTagLayoutProjection(prior,op),operations.slice(layoutIndex+1));
  }"""
new = """  const layoutIndex = operations.findIndex(row=>row.operationKind==='entry.tag-layout.set');
  if (layoutIndex >= 0) {
    const op = transportOperation(operations[layoutIndex]!);
    if (op.operationKind !== 'entry.tag-layout.set') throw new Error('Invalid tag layout');
    const prior = snapshotWithOverlays(snapshot,operations.slice(0,layoutIndex));
    return snapshotWithOverlays(applyTagLayoutProjection(prior,op),operations.slice(layoutIndex+1));
  }
  const tagApplyIndex = operations.findIndex(row=>row.operationKind==='entry.tag-layout.apply');
  if (tagApplyIndex >= 0) {
    const op = transportOperation(operations[tagApplyIndex]!);
    if (op.operationKind !== 'entry.tag-layout.apply') throw new Error('Invalid tag layout apply');
    const prior = snapshotWithOverlays(snapshot,operations.slice(0,tagApplyIndex));
    return snapshotWithOverlays(applyTagLayoutApplyProjection(prior,op),operations.slice(tagApplyIndex+1));
  }
  const templateApplyIndex = operations.findIndex(row=>row.operationKind==='entry.layout-template.apply');
  if (templateApplyIndex >= 0) {
    const op = transportOperation(operations[templateApplyIndex]!);
    if (op.operationKind !== 'entry.layout-template.apply') throw new Error('Invalid layout template apply');
    const prior = snapshotWithOverlays(snapshot,operations.slice(0,templateApplyIndex));
    return snapshotWithOverlays(applyLayoutTemplateApplyProjection(prior,op),operations.slice(templateApplyIndex+1));
  }"""
assert old in text, 'layout hook anchor missing'
text = text.replace(old, new, 1)

# 2. Projection functions, next to applyTagLayoutProjection.
anchor2 = "function viewLaterStateFromSnapshot(snapshot: SyncSnapshot): ViewLaterState {"
projections = """/** Apply-tag-layout: peer Entries of the type take the source Entry's placements. */
function applyTagLayoutApplyProjection(
  snapshot: SyncSnapshot,
  op: Extract<SyncReplayRequest, { operationKind: 'entry.tag-layout.apply' }>,
): SyncSnapshot {
  const result = structuredClone(snapshot), p = result.payload;
  const source = p.entries.find(row => row.syncUid === op.entityUid);
  if (!source) throw new Error('Tag layout apply owner missing');
  const peerIds = new Set(p.entries.filter(row => row.type === op.baseValues.entryType && row.syncUid !== op.entityUid).map(row => row.id));
  for (const assignment of op.baseValues.assignments) {
    const tag = p.tags.find(row => row.syncUid?.toLowerCase() === assignment.tagUid.toLowerCase());
    const facet = p.tagGroups.find(row => row.syncUid?.toLowerCase() === assignment.facetUid.toLowerCase());
    if (!tag || !facet) throw new Error('Tag layout apply needs trusted tag and Facet identities');
    for (const row of p.entryTags) {
      if (peerIds.has(row.entryId) && row.tagId === tag.id && row.facetId !== facet.id) row.facetId = facet.id;
    }
  }
  return result;
}

const layoutTemplateNameKey = (sectionName: string, facetName: string) => (
  sectionName.normalize('NFKC').trim().replace(/\\s+/gu, ' ').toLowerCase() + '\\u0000' + facetName.normalize('NFKC').trim().replace(/\\s+/gu, ' ').toLowerCase()
);

/** Save-as-template: fresh group identities plus the name-keyed assignment relink. */
function applyLayoutTemplateApplyProjection(
  snapshot: SyncSnapshot,
  op: Extract<SyncReplayRequest, { operationKind: 'entry.layout-template.apply' }>,
): SyncSnapshot {
  const result = structuredClone(snapshot), p = result.payload;
  const layout = p.entryTagLayouts?.find(row => row.syncUid === op.entityUid);
  if (!layout) throw new Error('Tag layout owner missing');
  const prior = p.tagGroups.filter(row => row.entryType === layout.entryType);
  const priorByUid = new Map(prior.filter(row => row.syncUid).map(row => [row.syncUid!.toLowerCase(), row]));
  const removedIds = new Set(prior.map(row => row.id));
  let nextId = Math.min(-1, ...prior.map(row => -Math.abs(row.id) - 1));
  const idByUid = new Map<string, number>();
  const nameKeyByOldId = new Map<number, string>();
  for (const group of op.payload.groups) {
    const id = priorByUid.get(group.syncUid.toLowerCase())?.id ?? (nextId -= 1);
    idByUid.set(group.syncUid.toLowerCase(), id);
  }
  for (const old of prior) {
    const oldSection = old.parentId === null ? null : prior.find(row => row.id === old.parentId);
    nameKeyByOldId.set(old.id, layoutTemplateNameKey(oldSection?.name ?? '', old.name));
  }
  const desired = op.payload.groups.map(group => ({
    id: idByUid.get(group.syncUid.toLowerCase())!,
    entryType: layout.entryType,
    name: group.name,
    groupKind: group.groupKind,
    parentId: group.parentUid === null ? null : idByUid.get(group.parentUid.toLowerCase()) ?? null,
    sortOrder: group.sortOrder,
    syncUid: group.syncUid,
  }));
  p.tagGroups = [...p.tagGroups.filter(row => row.entryType !== layout.entryType), ...desired];
  // Relink by (section, facet) name key; assignments with no rebuilt spelling
  // go to the first rebuilt default facet, mirroring the server.
  const fallback = op.payload.groups.find(row => row.groupKind === 'facet' && row.name === '');
  const fallbackId = fallback === undefined ? undefined : idByUid.get(fallback.syncUid.toLowerCase());
  const newKeys = new Map<string, number>();
  for (const group of op.payload.groups.filter(row => row.groupKind === 'facet')) {
    const section = op.payload.groups.find(row => row.groupKind === 'section' && row.syncUid.toLowerCase() === group.parentUid?.toLowerCase());
    const key = layoutTemplateNameKey(section?.name ?? '', group.name);
    if (!newKeys.has(key)) newKeys.set(key, idByUid.get(group.syncUid.toLowerCase())!);
  }
  p.entryTags = p.entryTags.map(row => {
    if (!removedIds.has(row.facetId)) return row;
    const key = nameKeyByOldId.get(row.facetId);
    const target = key !== undefined ? newKeys.get(key) : undefined;
    const mapped = target ?? fallbackId;
    return mapped === undefined ? row : { ...row, facetId: mapped };
  });
  // The rebuild journals one version bump per row DML, mirroring 08's delta rule.
  const inserts = op.payload.groups.filter(group => !priorByUid.has(group.syncUid.toLowerCase())).length;
  const deletes = prior.length;
  const sectionRenames = prior.filter(row => row.groupKind === 'section').length;
  p.entryTagLayouts = p.entryTagLayouts?.map(row => row.syncUid === op.entityUid ? { ...row, syncVersion: row.syncVersion + inserts + deletes + sectionRenames } : row);
  return result;
}

function viewLaterStateFromSnapshot(snapshot: SyncSnapshot): ViewLaterState {"""
assert anchor2 in text
text = text.replace(anchor2, projections, 1)

io.open(path, 'w', encoding='utf-8', newline='').write(text)
print('projections added')
