import { assert, assertEquals } from '@std/assert';
import Database from '../src/mod.ts';
import { initializeNative } from '../src/native/mod.ts';

initializeNative();

Deno.test('ICU supplies Unicode case mapping, LIKE, and Danish collation', () => {
  using db = new Database(':memory:');
  db.loadExtension(Deno.env.get('DENO_SQLITE_ICU_PATH')!, 'sqlite3_icu_init');
  assertEquals(
    db.prepare(`SELECT upper('abc æøå') AS upper,
      'æ' LIKE 'Æ' AS matching,
      lower('I', 'tr_TR') AS lower`).get(),
    { upper: 'ABC ÆØÅ', matching: 1, lower: 'ı' },
  );
  db.prepare("SELECT icu_load_collation('da_DK', 'danish')").get();
  db.exec('CREATE TABLE letters(value TEXT)');
  const insert = db.prepare('INSERT INTO letters VALUES (?)');
  for (const value of ['å', 'ø', 'z', 'æ']) insert.run(value);
  assertEquals(
    db.prepare('SELECT value FROM letters ORDER BY value COLLATE danish')
      .pluck().all(),
    ['z', 'æ', 'ø', 'å'],
  );
});

Deno.test('SpatiaLite metadata, geometry, INSERT RETURNING, and SELECT', () => {
  using db = new Database(':memory:');
  db.loadExtension(Deno.env.get('DENO_SQLITE_SPATIALITE_PATH')!);
  assert(
    typeof db.prepare('SELECT spatialite_version()').pluck().get() ===
      'string',
  );
  assertEquals(db.prepare('SELECT InitSpatialMetaData(1)').pluck().get(), 1);
  assertEquals(
    JSON.parse(
      db.prepare("SELECT AsGeoJSON(GeomFromText('MULTIPOINT(1.25 2.5)'))")
        .pluck().get() as string,
    ),
    { type: 'MultiPoint', coordinates: [[1.25, 2.5]] },
  );
  db.exec('CREATE TABLE places(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  assertEquals(
    db.prepare(
      "SELECT AddGeometryColumn('places', 'geom', 4326, 'POINT', 'XY')",
    )
      .pluck().get(),
    1,
  );
  const rows = db.prepare(`INSERT INTO places(name, geom)
    VALUES (?, MakePoint(?, ?, 4326))
    RETURNING id, name, AsText(geom) AS geometry, Srid(geom) AS srid`)
    .all('København', 12.5, 55.75);
  assertEquals(rows, [{
    id: 1,
    name: 'København',
    geometry: 'POINT(12.5 55.75)',
    srid: 4326,
  }]);
  assertEquals(
    db.prepare(
      'SELECT id, name, AsText(geom) AS geometry, Srid(geom) AS srid FROM places',
    )
      .all(),
    rows,
  );
  assertEquals(
    db.prepare(
      'SELECT name FROM places WHERE ST_Intersects(geom, BuildMbr(12, 55, 13, 56, 4326))',
    )
      .pluck().all(),
    ['København'],
  );
});
