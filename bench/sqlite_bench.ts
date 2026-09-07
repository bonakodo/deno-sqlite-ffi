/** Run with deno task bench. Each case reuses its prepared statement. */
import Database from '../src/mod.ts';
import { registerBenchmarks } from './workloads.ts';

registerBenchmarks(new Database(':memory:'));
