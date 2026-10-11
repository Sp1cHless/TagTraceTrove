-- Bring every existing Gallery's works summary into step with its work dimensions.
--
-- A Gallery's work dimensions ARE the works summary's dimensions: that class exists to answer "how
-- good is this author's body of work, on the same axes the works are rated on". `039` introduced the
-- class but could only keep what an import had already mirrored name by name, so the two partitions
-- had drifted: measured on a real library, `Comic` and `Hentai` matched exactly, while `AV` (four
-- dimensions), `电影` and `小说` had work dimensions and NO summary dimension at all — an author in
-- those Galleries had no rating row to fill. From here on `createRatingSlot` keeps them in step by
-- construction; this is the one-time catch-up for what already exists.
--
-- Names only. No value is created, moved or removed, and a summary dimension that already exists is
-- left exactly as it is — which is what keeps every rating a person has entered untouched. The
-- resulting insert is a real layout change: the sync triggers journal it for each partition.
INSERT INTO rating_slots (subject_kind, entry_type, name, sort_order, sync_uid)
SELECT 'producer', slot.entry_type, slot.name, slot.sort_order,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
FROM rating_slots AS slot
WHERE slot.subject_kind = 'entry'
  AND NOT EXISTS (
    SELECT 1
    FROM rating_slots AS summary
    WHERE summary.subject_kind = 'producer'
      AND summary.entry_type = slot.entry_type
      AND summary.name = slot.name
  )
ORDER BY slot.id;
