exec((__import__('pathlib').Path(__file__).parent/'options.py').read_text().split("patch('apps/web/src/offline/offline-library.ts'")[0])
patch('apps/server/src/repositories/producer-tag-repository.ts', "  '(SELECT own.stars FROM producer_rating_values AS own WHERE own.producer_id = id AND own.slot_id = ?)';", """  '(SELECT own.stars FROM producer_rating_values AS own'
  + ' JOIN rating_slots AS slot ON slot.id = own.slot_id'
  + " WHERE own.producer_id = producer_candidates.id AND own.slot_id = ?"
  + " AND slot.subject_kind = 'author_self' AND slot.entry_type = producer_candidates.gallery_type)";""")
