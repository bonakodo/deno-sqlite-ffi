import Database from '@bonakodo/sqlite';

using db = new Database(':memory:');
db.exec('CREATE TABLE cats(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
using insert = db.prepare('INSERT INTO cats(name) VALUES (@name)');
insert.run({ name: 'Mochi' });
using select = db.prepare<{ id: number; name: string }>('SELECT * FROM cats');
const cat = select.get();
if (cat?.id !== 1 || cat.name !== 'Mochi') throw new Error('Unexpected row');
console.log(cat);
