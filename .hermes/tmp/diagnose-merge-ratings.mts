/** Diagnoses the merge-plan step of the new rating test. */
import { createMigratedMemoryDatabase } from '../../apps/server/src/database/testing.js';
import { createEntry } from '../../apps/server/src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../apps/server/src/repositories/producer-repository.js';
import {
  createProducerRatingSlot,
  setProducerRating,
} from '../../apps/server/src/repositories/rating-repository.js';
import { planProducerMerges, executeProducerMerges } from '../../apps/server/src/import/merge-producers.js';

const database = createMigratedMemoryDatabase();
const keeperWork = createEntry(database, { title: 'Keeper work', type: 'comic' });
const absorbedWork = createEntry(database, { title: 'Absorbed work', type: 'comic' });
const keeper = createProducer(database, { name: 'bansee' });
const absorbed = createProducer(database, { name: 'Banssee' });
linkEntryProducer(database, keeperWork.id, keeper.id);
linkEntryProducer(database, absorbedWork.id, absorbed.id);
const keeperSlot = createProducerRatingSlot(database, { producerId: keeper.id, name: '画风精美' });
const absorbedSlot = createProducerRatingSlot(database, { producerId: absorbed.id, name: '画风精美' });
setProducerRating(database, { producerId: keeper.id, slotId: keeperSlot.id, stars: 3 });
setProducerRating(database, { producerId: absorbed.id, slotId: absorbedSlot.id, stars: 5 });

database.pragma('foreign_keys = OFF');
try {
  database.prepare(`INSERT INTO producer_rating_values (slot_id, producer_id, stars, updated_at) VALUES (?, 9999, 4.5, CURRENT_TIMESTAMP)`).run(absorbedSlot.id);
} finally {
  database.pragma('foreign_keys = ON');
}

console.log('plans:', JSON.stringify(planProducerMerges(database).map((plan) => ({
  keeper: plan.keeper,
  others: plan.others,
})), null, 2));
database.pragma('foreign_keys = OFF');
try {
  console.log('executions:', JSON.stringify(executeProducerMerges(database, planProducerMerges(database))));
} finally {
  database.pragma('foreign_keys = ON');
}
console.log('producers:', JSON.stringify(database.prepare('SELECT id, name FROM producers ORDER BY id').all()));
console.log('values:', JSON.stringify(database.prepare('SELECT slot_id, producer_id, stars FROM producer_rating_values ORDER BY slot_id').all()));
console.log('fk check:', JSON.stringify(database.pragma('foreign_key_check')));
database.close();
