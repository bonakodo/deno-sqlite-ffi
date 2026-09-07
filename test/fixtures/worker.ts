/// <reference lib="deno.worker" />

import Database from '../../src/mod.ts';
globalThis.onmessage = (event: MessageEvent<number>) => {
  try {
    using db = new Database(':memory:');
    db.function('double', (value) => Number(value) * 2);
    const result = db.prepare('SELECT double(?) AS value').get(event.data);
    globalThis.postMessage(result);
  } catch (error) {
    globalThis.postMessage({ error: String(error) });
  }
};
