exec((__import__('pathlib').Path(__file__).parent/'options.py').read_text().split("patch('apps/web/src/offline/offline-library.ts'")[0])
patch('apps/web/src/offline/offline-library.ts', '''    const requestedIds = input.producerIds === undefined ? null : new Set(input.producerIds);''', '''    const requireAuthorRatingSlot = (slotId: number) => {
      const slot = payload.ratingSlots.find(row => row.id === slotId && row.subjectKind === 'author_self');
      if (!slot) throw new Error(`cannot filter: rating slot ${slotId} is not an Author's own rating dimension`);
      return slot;
    };
    for (const condition of input.ratingConditions ?? []) requireAuthorRatingSlot(condition.slotId);
    if (input.ratingSort) requireAuthorRatingSlot(input.ratingSort.slotId);
    const authorStars = (producerId: number, galleryType: string | null, slotId: number) => {
      const slot = requireAuthorRatingSlot(slotId);
      if (slot.entryType !== galleryType) return null;
      return payload.producerRatingValues.find(row => row.producerId === producerId && row.slotId === slotId)?.stars ?? null;
    };
    const requestedIds = input.producerIds === undefined ? null : new Set(input.producerIds);''')
patch('apps/web/src/offline/offline-library.ts', '''      const summary = summaryForProducer(producer, input.includeNsfw);
      if (summary === null) return [];''', '''      const summary = summaryForProducer(producer);
      if (summary === null || (!input.includeNsfw && summary.nsfw)) return [];''')
patch('apps/web/src/offline/offline-library.ts', '''      if (input.entryType !== undefined && !linkedEntries.some((entry) => entry.type === input.entryType)) return [];''', '''      if (input.entryType !== undefined && summary.galleryType !== input.entryType) return [];''')
patch('apps/web/src/offline/offline-library.ts', '''        const slot = payload.ratingSlots.find(row => row.id === condition.slotId && row.subjectKind === 'author_self');
        const stars = slot ? payload.producerRatingValues.find(row => row.producerId === producer.id && row.slotId === slot.id)?.stars ?? null : null;''', '''        const stars = authorStars(producer.id, summary.galleryType, condition.slotId);''')
patch('apps/web/src/offline/offline-library.ts', '''        const stars = (id: number) => payload.producerRatingValues.find(row => row.producerId === id && row.slotId === input.ratingSort!.slotId)?.stars ?? null;
        const a = stars(left.id), b = stars(right.id);''', '''        const a = authorStars(left.id, left.galleryType, input.ratingSort.slotId);
        const b = authorStars(right.id, right.galleryType, input.ratingSort.slotId);''')
