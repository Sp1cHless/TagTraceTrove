import io

path = r'D:\Project\TagTraceTrove\apps\web\src\offline\offline-api.ts'
text = io.open(path, encoding='utf-8').read()

# 1. Enqueue functions: after enqueueTagLayout (anchor: the offlineEntrySources helper above it).
anchor = "  function offlineEntrySources(snapshot: SyncSnapshot, entryId: number): import('@t3/shared').EntrySourceRecordDto[] {"
add = """  async function enqueueEntryTagLayoutApply(entryId: number, transportError?: unknown): Promise<import('@t3/shared').TagLayoutApplyResponse> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Tag layout apply needs a durable local queue');
    if (await store.readMeta('capability.offlineMutations') !== '1' || await store.readMeta('capability.offlineEntryTagLayout') !== '1') {
      throw new Error('Tag layout apply is not available under offline; update this copy online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Tag layout apply needs a trusted saved copy');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const source = projected.payload.entries.find(row => row.id === entryId);
    if (!source?.syncUid || source.syncVersion === undefined) {
      throw new Error('Tag layout apply needs a server-synced source Entry; refresh this offline copy');
    }
    const assignments = projected.payload.entryTags
      .filter(row => row.entryId === entryId)
      .map(row => {
        const tag = projected.payload.tags.find(candidate => candidate.id === row.tagId);
        const facet = projected.payload.tagGroups.find(candidate => candidate.id === row.facetId);
        if (!tag?.syncUid || !facet?.syncUid) throw new Error('Refresh this offline copy; an assignment is missing stable identity');
        return { tagUid: tag.syncUid, facetUid: facet.syncUid };
      });
    if (assignments.length === 0) {
      return { entryType: source.type, entriesAffected: 0, tagsMoved: 0, entriesScanned: Math.max(0, projected.payload.entries.filter(row => row.type === source.type).length - 1), backupPath: null, foreignKeyCheckPass: true, doctorPass: true, doctorIssues: [], templateFiles: null };
    }
    const operation = createPendingSyncOperation({
      clientId, libraryId: active.snapshot.header.libraryId, syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry', entityUid: source.syncUid, operationKind: 'entry.tag-layout.apply',
      baseVersion: source.syncVersion,
      baseValues: { entryType: source.type, assignments }, payload: {},
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    setReplayStateFromOperations([...operations, normalized]);
    invalidateOfflineLibrary();
    setMode('offline');
    return { entryType: source.type, entriesAffected: 0, tagsMoved: 0, entriesScanned: Math.max(0, projected.payload.entries.filter(row => row.type === source.type).length - 1), backupPath: null, foreignKeyCheckPass: true, doctorPass: true, doctorIssues: [], templateFiles: null };
  }

  async function enqueueLayoutTemplateApply(entryId: number, transportError?: unknown): Promise<import('@t3/shared').LayoutTemplateApplyResponse> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Layout template apply needs a durable local queue');
    if (await store.readMeta('capability.offlineMutations') !== '1' || await store.readMeta('capability.offlineEntryTagLayout') !== '1') {
      throw new Error('Layout template apply is not available under offline; update this copy online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Layout template apply needs a trusted saved copy');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const source = projected.payload.entries.find(row => row.id === entryId);
    if (!source) throw new Error('The open Entry is not available in the offline copy');
    const layout = projected.payload.entryTagLayouts?.find(row => row.entryType === source.type);
    if (!layout) throw new Error('Refresh this offline copy; the tag layout is missing stable identity');
    const current = projected.payload.tagGroups
      .filter(row => row.entryType === source.type)
      .map(row => {
        if (!row.syncUid) throw new Error('Refresh this offline copy before applying the layout; a group is missing stable identity');
        const parent = row.parentId === null ? null : projected.payload.tagGroups.find(candidate => candidate.id === row.parentId && candidate.entryType === source.type);
        if (row.parentId !== null && !parent?.syncUid) throw new Error('Refresh this offline copy before applying the layout; a section is missing stable identity');
        return { syncUid: row.syncUid, name: row.name, groupKind: row.groupKind, parentUid: parent?.syncUid ?? null, sortOrder: row.sortOrder };
      });
    // Rebuild with fresh identities: facet spellings deduplicate per Section,
    // keeping the first occurrence, exactly like the server rebuild.
    const desired: Array<{ syncUid: string; name: string; groupKind: 'section' | 'facet'; parentUid: string | null; sortOrder: number }> = [];
    const seenSpelling = new Set<string>();
    for (const section of current.filter(row => row.groupKind === 'section')) {
      const sectionUid = randomUUID();
      desired.push({ syncUid: sectionUid, name: section.name, groupKind: 'section', parentUid: null, sortOrder: section.sortOrder });
      const seenFacets = new Set<string>();
      for (const facet of current.filter(row => row.groupKind === 'facet' && row.parentUid?.toLowerCase() === section.syncUid.toLowerCase())) {
        const key = facet.name === '' ? '' : facet.name.normalize('NFKC').trim().replace(/\\s+/gu, ' ').toLowerCase();
        if (key !== '' && seenFacets.has(key)) continue;
        seenFacets.add(key);
        desired.push({ syncUid: randomUUID(), name: facet.name, groupKind: 'facet', parentUid: sectionUid, sortOrder: facet.sortOrder });
      }
    }
    const entriesAffected = projected.payload.entries.filter(row => row.type === source.type).length;
    const operation = createPendingSyncOperation({
      clientId, libraryId: active.snapshot.header.libraryId, syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry_tag_layout', entityUid: layout.syncUid, operationKind: 'entry.layout-template.apply',
      baseVersion: layout.syncVersion, baseValues: { groups: current }, payload: { groups: desired },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    setReplayStateFromOperations([...operations, normalized]);
    invalidateOfflineLibrary();
    setMode('offline');
    const relinkedIds = new Set(current.filter(row => row.groupKind === 'facet').map(row => row.syncUid.toLowerCase()));
    const tagsRelinked = projected.payload.entryTags.filter(row => {
      const facet = projected.payload.tagGroups.find(candidate => candidate.id === row.facetId && candidate.entryType === source.type);
      return facet !== undefined && relinkedIds.has(facet.syncUid!.toLowerCase());
    }).length;
    return {
      entryType: source.type, entriesAffected, tagsRelinked, orphansMoved: 0,
      sectionsRecreated: current.filter(row => row.groupKind === 'section').length,
      backupPath: null, foreignKeyCheckPass: true, doctorPass: true, doctorIssues: [], templateFiles: null,
    };
  }

  function offlineEntrySources(snapshot: SyncSnapshot, entryId: number): import('@t3/shared').EntrySourceRecordDto[] {"""
assert anchor in text, 'enqueue anchor missing'
text = text.replace(anchor, add, 1)

# 2. Facade overrides: after the reorderSectionFacets override's closing (anchor: async addCollectionTag).
anchor2 = "    async addCollectionTag(collectionId,name) {"
overrides = """    async applyEntryTagLayout(entryId) {
      if (isOnlineMode()) {
        try {
          return await online.applyEntryTagLayout(entryId);
        } catch (cause) {
          if (!isOfflineTransportError(cause)) throw cause;
          setMode('offline');
          if (options.state !== undefined) options.state.lastFallbackAt = new Date().toISOString();
          return enqueueEntryTagLayoutApply(entryId, cause);
        }
      }
      return enqueueEntryTagLayoutApply(entryId);
    },
    async applyEntryLayoutTemplate(entryId) {
      if (isOnlineMode()) {
        try {
          return await online.applyEntryLayoutTemplate(entryId);
        } catch (cause) {
          if (!isOfflineTransportError(cause)) throw cause;
          setMode('offline');
          if (options.state !== undefined) options.state.lastFallbackAt = new Date().toISOString();
          return enqueueLayoutTemplateApply(entryId, cause);
        }
      }
      return enqueueLayoutTemplateApply(entryId);
    },
    async addCollectionTag(collectionId,name) {"""
assert anchor2 in text
text = text.replace(anchor2, overrides, 1)

io.open(path, 'w', encoding='utf-8', newline='').write(text)
print('enqueue + facade added')
