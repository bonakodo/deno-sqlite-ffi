import Database, { SqliteError, type Statement } from '../../src/mod.ts';
import { Connection } from '../../src/api/connection.ts';
import { native } from '../../src/native/loader.ts';
import type { Symbols } from '../../src/native/symbols.ts';
import type {
  Event,
  Observation,
  Operation,
  Response,
  State,
  Trace,
} from './protocol.ts';

interface Allocation {
  allocation: string;
  address: string;
  pointer: Deno.PointerValue;
  nativeAddress: bigint;
  live: boolean;
  statement?: Statement<{ value: number }>;
  generations: bigint;
}
interface IteratorRecord {
  iterator: IterableIterator<{ value: number }>;
  closed: boolean;
}
interface NativeLifetime {
  live: boolean;
  observed?: Allocation;
}
export interface GateReport {
  prepared: number;
  forwardedFinalizes: number;
  blockedDuplicateFinalizes: number;
  bootstrapBlockedFinalizes: number;
}
class Injected extends Error {
  constructor(readonly kind: string) {
    super(`Injected ${kind} failure`);
  }
}

function errorOutcome(error: unknown): string {
  if (error instanceof Injected) return `error:${error.kind}`;
  if (error instanceof SqliteError) return 'error:native';
  if (error instanceof TypeError) {
    if (error.message.includes('not open')) return 'error:closed';
    if (error.message.includes('busy')) return 'error:busy';
    if (error.message.includes('finalized')) return 'error:finalized';
    if (error.message.includes('does not return data')) return 'error:reader';
  }
  throw error;
}

let instrumented = false;

/**
 * Observe the real classes and SQLite, with all patches confined to this call.
 * Address labels are virtual observations; real pointers always go to SQLite.
 */
export function execute(
  trace: Trace,
  inspect?: (observation: Observation, index: number) => void,
  inspectGate?: (report: GateReport) => void,
): Response {
  if (instrumented) throw new Error('Native instrumentation must run serially');
  instrumented = true;
  const sql = native();
  const saved: Partial<Symbols> = {};
  function patch<K extends keyof Symbols>(
    name: K,
    replacement: Symbols[K],
  ): void {
    // Indexed writes preserve the exact symbol type at this boundary.
    (saved as Record<string, unknown>)[name] = sql[name];
    sql[name] = replacement;
  }
  const allocations: Allocation[] = [];
  const byAddress = new Map<bigint, Allocation>();
  const byPointer = new Map<Deno.PointerObject, Allocation>();
  const nativeByAddress = new Map<bigint, NativeLifetime>();
  const nativeByPointer = new Map<Deno.PointerObject, NativeLifetime>();
  const iterators = new Map<string, IteratorRecord>();
  const steps: Observation[] = [];
  let events: Event[] = [];
  let current: Operation = { kind: 'close' };
  let recording = false;
  let cleaning = false;
  const gate: GateReport = {
    prepared: 0,
    forwardedFinalizes: 0,
    blockedDuplicateFinalizes: 0,
    bootstrapBlockedFinalizes: 0,
  };
  let probingReentry = false;
  let connection: Connection | undefined;
  let database: Database | undefined;
  let result: Response | undefined;
  let cleanupError: unknown;
  const originalPrepare = Connection.prototype.prepare;
  function lifetime(pointer: Deno.PointerValue): NativeLifetime {
    if (pointer === null) throw new Error('Unexpected null statement pointer');
    const item = nativeByPointer.get(pointer) ??
      nativeByAddress.get(Deno.UnsafePointer.value(pointer));
    if (!item) throw new Error('Untracked pointer blocked before SQLite');
    nativeByPointer.set(pointer, item);
    return item;
  }
  function allocation(pointer: Deno.PointerValue): Allocation {
    if (pointer === null) throw new Error('Unexpected null statement pointer');
    const result = byPointer.get(pointer) ??
      byAddress.get(Deno.UnsafePointer.value(pointer));
    if (!result) throw new Error('Observed an untracked native statement');
    byPointer.set(pointer, result);
    return result;
  }
  function event(kind: string, item?: Allocation): void {
    if (recording) {
      events.push({
        kind,
        allocation: item?.allocation ?? '',
        address: item?.address ?? '',
      });
    }
  }
  function snapshot(): State {
    const c = connection!;
    return {
      open: database!.open,
      executing: c.executing,
      iterators: String(c.iterators),
      statements: allocations.map((item) => ({
        allocation: item.allocation,
        address: item.address,
        live: [...c.statements].some((pointer) =>
          byPointer.get(pointer) === item ||
          (Deno.UnsafePointer.value(pointer) === item.nativeAddress &&
            item.live)
        ),
        busy: item.statement?.busy ?? false,
      })),
    };
  }
  function reenter(): void {
    const before = snapshot();
    const item = allocations.find((item) =>
      item.allocation === current.statement
    );
    const record = iterators.get(
      `${current.statement}:${current.iterator ?? '0'}`,
    );
    const attempts: [string, () => string][] = [
      ['prepare', () => {
        database!.prepare('SELECT 1');
        return 'unexpected-success';
      }],
      ['close', () => {
        database!.close();
        return 'closed';
      }],
      ['get', () => {
        const row = item?.statement?.get();
        return row ? `row:${row.value}` : 'done';
      }],
      ['dispose', () => {
        item?.statement?.[Symbol.dispose]();
        return 'disposed';
      }],
      ['next', () => {
        if (!record) return 'error:missing';
        const row = record.iterator.next();
        return row.done ? 'done' : `row:${row.value.value}`;
      }],
      ['return', () => {
        if (!record) return 'error:missing';
        record.iterator.return!();
        return 'done';
      }],
    ];
    probingReentry = true;
    try {
      for (const [kind, attempt] of attempts) {
        let outcome: string;
        try {
          outcome = attempt();
        } catch (error) {
          outcome = errorOutcome(error);
        }
        event(
          `reenter:${kind}:${outcome}:${
            connection!.executing ? 'guarded' : 'unguarded'
          }`,
          item,
        );
        if (JSON.stringify(snapshot()) !== JSON.stringify(before)) {
          throw new Error('Reentry corrupted the outer operation state');
        }
      }
      // Probe distinct iterator owners too. The six serialized probe outcomes
      // above use the same nested transition definitions as Lean.
      for (const other of iterators.values()) {
        if (other === record) continue;
        for (
          const call of [
            () => other.iterator.next(),
            () => other.iterator.return!(),
          ]
        ) {
          if (other.closed) {
            if (!call().done) {
              throw new Error('Closed iterator reopened during reentry');
            }
          } else {
            let rejected = false;
            try {
              call();
            } catch (error) {
              rejected = errorOutcome(error) === 'error:busy';
            }
            if (!rejected) {
              throw new Error('Distinct iterator accepted reentry');
            }
          }
          if (JSON.stringify(snapshot()) !== JSON.stringify(before)) {
            throw new Error('Distinct iterator reentry corrupted ownership');
          }
        }
      }
    } finally {
      probingReentry = false;
    }
  }
  function nativeGate(): void {
    if (probingReentry) {
      throw new Error(
        'Reentrant operation reached native boundary; blocked before SQLite',
      );
    }
  }
  const prepareNative = sql.sqlite3_prepare_v2;
  const stepNative = sql.sqlite3_step;
  const resetNative = sql.sqlite3_reset;
  const finalizeNative = sql.sqlite3_finalize;
  const closeNative = sql.sqlite3_close_v2;
  const columnTypeNative = sql.sqlite3_column_type;
  try {
    Connection.prototype.prepare = function (source) {
      connection = this;
      const prepared = originalPrepare.call(this, source);
      if (recording && prepared.statement) {
        const item = allocation(prepared.statement);
        item.pointer = prepared.statement;
      }
      return prepared;
    };
    patch('sqlite3_prepare_v2', (...args) => {
      nativeGate();
      if (recording && current.fault === 'prepare') {
        event('prepare');
        return 1;
      }
      const rc = prepareNative(...args);
      const output = args[3] as BigUint64Array;
      const address = output[0]!;
      if (address !== 0n) {
        // Constructor PRAGMAs and setup statements are outside the trace, but
        // the safety gate must track them before any source mutant can run.
        const life: NativeLifetime = { live: true };
        gate.prepared++;
        nativeByAddress.set(address, life);
        if (!recording) return rc;
        const item: Allocation = {
          allocation: String(allocations.length),
          address: current.address!,
          pointer: null,
          nativeAddress: address,
          live: true,
          generations: 0n,
        };
        allocations.push(item);
        life.observed = item;
        byAddress.set(address, item);
        event('prepare', item);
      } else event('prepare');
      return current.fault === 'partialPrepare' ? 1 : rc;
    });
    patch('sqlite3_step', (pointer) => {
      nativeGate();
      const life = lifetime(pointer);
      event('step', life.observed);
      if (!life.live) throw new Error('Native step after finalization');
      return current.fault === 'step' || current.fault === 'stepResetCallback'
        ? 1
        : stepNative(pointer);
    });
    patch('sqlite3_reset', (pointer) => {
      nativeGate();
      const life = lifetime(pointer);
      event('reset', life.observed);
      if (!life.live) throw new Error('Native reset after finalization');
      const rc = resetNative(pointer);
      if (current.fault === 'resetReenter') reenter();
      if (
        current.fault === 'resetCallback' ||
        current.fault === 'stepResetCallback'
      ) {
        connection!.error = { value: new Injected('callback') };
      }
      return current.fault === 'reset' ? 1 : rc;
    });
    patch('sqlite3_finalize', (pointer) => {
      nativeGate();
      const life = lifetime(pointer);
      event('finalize', life.observed);
      // Detect an unsafe call without forwarding a freed pointer to SQLite.
      if (!life.live) {
        gate.blockedDuplicateFinalizes++;
        if (!recording && !cleaning) gate.bootstrapBlockedFinalizes++;
        return 0;
      }
      life.live = false;
      if (life.observed) life.observed.live = false;
      gate.forwardedFinalizes++;
      const rc = finalizeNative(pointer);
      return current.fault === 'finalize' ? 1 : rc;
    });
    patch('sqlite3_close_v2', (pointer) => {
      nativeGate();
      event('close');
      return closeNative(pointer);
    });
    patch('sqlite3_column_type', (...args) => {
      if (recording && current.fault === 'row') throw new Injected('row');
      return columnTypeNative(...args);
    });
    database = new Database(':memory:', {
      verbose() {
        if (!recording) return;
        if (current.fault === 'verbose') throw new Injected('verbose');
        if (current.fault === 'verboseReenter') reenter();
      },
    });
    database.function('model_value', (value) => {
      if (current.fault === 'callback') throw new Injected('callback');
      if (current.fault === 'callbackReenter') reenter();
      return value;
    });
    database.exec('CREATE TABLE model_rows(value INTEGER)');
    recording = true;
    for (const op of trace.ops) {
      current = op;
      events = [];
      let outcome: string;
      try {
        if (op.kind === 'prepare') {
          const query = op.write
            ? `INSERT INTO model_rows SELECT x FROM (SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3) WHERE $binding IS NULL${
              op.reader === false ? '' : ' RETURNING value'
            }`
            : 'WITH t(x) AS (VALUES(1),(2),(3)) SELECT model_value(x) AS value FROM t WHERE $binding IS NULL';
          const statement = database.prepare<{ value: number }>(
            query,
          );
          const item = allocations.at(-1)!;
          item.statement = statement;
          outcome = `prepared:${item.allocation}`;
        } else if (op.kind === 'close') {
          database.close();
          outcome = 'closed';
        } else {
          const item = allocations.find((item) =>
            item.allocation === op.statement
          );
          const statement = item?.statement;
          const parameters = { binding: null };
          if (!statement) outcome = 'error:missing';
          else if (op.kind === 'iterate') {
            const iterator = statement.iterate(parameters);
            const generation = String(item.generations++);
            iterators.set(`${op.statement}:${generation}`, {
              iterator,
              closed: false,
            });
            outcome = `iterator:${generation}`;
          } else if (op.kind === 'next' || op.kind === 'return') {
            const record = iterators.get(`${op.statement}:${op.iterator}`);
            if (!record) outcome = 'error:missing';
            else {
              try {
                const result = op.kind === 'next'
                  ? record.iterator.next()
                  : record.iterator.return!();
                record.closed ||= result.done === true;
                outcome = result.done ? 'done' : `row:${result.value.value}`;
              } catch (error) {
                // Rejected calls retain ownership; row/step failures close it.
                if (!statement.busy) record.closed = true;
                throw error;
              }
            }
          } else if (op.kind === 'get') {
            const row = statement.get(parameters);
            outcome = row ? `row:${row.value}` : 'done';
          } else if (op.kind === 'all') {
            outcome = `rows:${
              statement.all(parameters).map((row) => row.value).join(',')
            }`;
          } else if (op.kind === 'run') {
            const result = statement.run(parameters);
            outcome = `run:${result.changes}`;
          } else {
            statement[Symbol.dispose]();
            outcome = 'disposed';
          }
        }
      } catch (error) {
        outcome = errorOutcome(error);
      }
      const observation = { outcome, events, state: snapshot() };
      steps.push(observation);
      inspect?.(observation, steps.length - 1);
    }
    result = { v: 1, steps };
  } finally {
    cleaning = true;
    recording = false;
    current = { kind: 'close' };
    Connection.prototype.prepare = originalPrepare;
    try {
      for (const record of iterators.values()) {
        try {
          record.iterator.return!();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      // The mutant can leave its counter wrong. Internal close still releases
      // real resources after all actual iterators have returned.
    } finally {
      try {
        connection?.close();
      } finally {
        connection?.statements.clear();
        for (const [name, original] of Object.entries(saved)) {
          (sql as unknown as Record<string, unknown>)[name] = original;
        }
        instrumented = false;
        inspectGate?.({ ...gate });
      }
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
}
