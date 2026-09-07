import Database from '@bonakodo/sqlite';

using db = new Database(':memory:');
db.exec(
  'CREATE TABLE items(value INTEGER); INSERT INTO items VALUES(1),(2),(3)',
);
db.function('double', (value) => Number(value) * 2);
db.aggregate('sum_js', {
  start: 0,
  step: (sum, value) => sum + Number(value),
  inverse: (sum, value) => sum - Number(value),
});
db.table('sequence', {
  columns: ['value'],
  parameters: ['length'],
  rows: function* (length) {
    for (let i = 0; i < Number(length); i++) yield [i];
  },
});
console.log(
  db.prepare(
    'SELECT double(value), sum_js(value) OVER (ROWS 1 PRECEDING) FROM items',
  ).all(),
);
console.log(db.prepare('SELECT * FROM sequence(3)').all());

const bytes = db.serialize();
using restored = new Database(bytes);
if (restored.prepare('SELECT count(*) FROM items').pluck().get() !== 3) {
  throw new Error('Restore failed');
}

// Pass a destination argument to also write a backup.
if (Deno.args[0]) {
  console.log(
    await db.backup(Deno.args[0], {
      progress: (state) => {
        console.log(state);
      },
    }),
  );
}
