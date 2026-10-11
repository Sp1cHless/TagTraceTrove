import runpy
from pathlib import Path
r=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']
f='apps/web/src/offline/offline-library.ts'
s=Path(f).read_text();start=s.index('    const effectiveRating = (entryId: number)');end=s.index('    entries = [...entries].sort',start)
r(f,s[start:end], '')
r(f,'effectiveRating(left.id);','effectiveRating(left.id, input.ratingSort.slotId);')
r(f,'effectiveRating(right.id);','effectiveRating(right.id, input.ratingSort.slotId);')
r(f,"      return [summary];", """      if (!(input.ratingConditions ?? []).every(condition => {
        const slot = payload.ratingSlots.find(row => row.id === condition.slotId && row.subjectKind === 'author_self');
        const stars = slot ? payload.producerRatingValues.find(row => row.producerId === producer.id && row.slotId === slot.id)?.stars ?? null : null;
        if (condition.operator === 'unrated') return stars === null;
        if (stars === null || condition.stars === null) return false;
        return condition.operator === 'eq' ? stars === condition.stars : condition.operator === 'gt' ? stars > condition.stars : stars < condition.stars;
      })) return [];
      return [summary];""")
r(f,"    authors = authors.sort((left, right) => {", """    authors = authors.sort((left, right) => {
      if (input.ratingSort) {
        const stars = (id: number) => payload.producerRatingValues.find(row => row.producerId === id && row.slotId === input.ratingSort!.slotId)?.stars ?? null;
        const a = stars(left.id), b = stars(right.id);
        if (a === null && b !== null) return 1;
        if (b === null && a !== null) return -1;
        if (a !== null && b !== null && a !== b) return b - a;
      }""")
r(f,"ratingSlots: [],\n    };\n  }\n\n  function searchTags", """ratingSlots: payload.ratingSlots.filter(slot => slot.subjectKind === 'author_self'
        && payload.producerRatingValues.some(row => row.slotId === slot.id && row.stars !== null && visibleProducerIds.has(row.producerId)))
        .sort((a,b) => a.entryType.localeCompare(b.entryType) || a.sortOrder-b.sortOrder || a.id-b.id)
        .map(slot => ({id:slot.id,name:slot.name,sortOrder:slot.sortOrder,entryType:slot.entryType})),
    };
  }

  function searchTags""")
