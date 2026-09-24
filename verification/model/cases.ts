import { type Fault, faults, type Operation, type Trace } from './protocol.ts';

export const SEEDS = [
  1,
  7,
  19,
  42,
  73,
  101,
  313,
  997,
  2026,
  65537,
  104729,
  4294967295,
];
export const GENERATED_STEPS = 96;
export const ADDRESS = '18446744073709551601';
const prepare = (
  address = ADDRESS,
  extra: Partial<Operation> = {},
): Operation => ({
  kind: 'prepare',
  address,
  ...extra,
});
const op = (
  kind: Operation['kind'],
  extra: Partial<Operation> = {},
): Operation => ({
  kind,
  statement: '0',
  ...extra,
});
const next = (extra: Partial<Operation> = {}): Operation =>
  op('next', { iterator: '0', ...extra });
const finish = (extra: Partial<Operation> = {}): Operation =>
  op('return', { iterator: '0', ...extra });

export function focused(): { name: string; trace: Trace }[] {
  const result: { name: string; trace: Trace }[] = [];
  const add = (name: string, ops: Operation[]) =>
    result.push({ name, trace: { v: 1, ops } });
  add('normal-and-repeated-cleanup', [
    prepare(),
    op('get'),
    op('all'),
    op('run'),
    op('iterate'),
    next(),
    next(),
    next(),
    next(),
    next(),
    finish(),
    finish(),
    op('dispose'),
    op('dispose'),
    op('get'),
    { kind: 'close' },
    { kind: 'close' },
    op('get'),
    op('dispose'),
    next(),
    finish(),
  ]);
  add('distinct-statements-and-early-return', [
    prepare(),
    prepare('9007199254740993'),
    op('iterate'),
    next(),
    op('get'),
    op('dispose'),
    { kind: 'close' },
    op('get', { statement: '1' }),
    op('iterate', { statement: '1' }),
    finish(),
    finish(),
    next({ statement: '1' }),
    finish({ statement: '1' }),
    op('dispose'),
    op('dispose', { statement: '1' }),
    { kind: 'close' },
  ]);
  add('address-reuse-distinct-allocations', [
    prepare(),
    op('dispose'),
    prepare(),
    op('get'),
    op('dispose'),
    op('all', { statement: '1' }),
    op('dispose', { statement: '1' }),
    prepare(),
    op('run', { statement: '2' }),
    { kind: 'close' },
  ]);
  add('partial-prepare-allocation-cleanup', [
    prepare(ADDRESS, { fault: 'partialPrepare' }),
    op('get'),
    op('dispose'),
    prepare(ADDRESS, { fault: 'prepare' }),
    prepare(),
    op('get', { statement: '1' }),
    { kind: 'close' },
    prepare(ADDRESS, { fault: 'partialPrepare' }),
  ]);
  add('finalize-error-still-releases', [
    prepare(),
    prepare(),
    op('dispose', { fault: 'finalize' }),
    op('dispose', { fault: 'finalize' }),
    op('get'),
    { kind: 'close', fault: 'finalize' },
    { kind: 'close', fault: 'finalize' },
  ]);
  add('write-owner-and-reader-rejections', [
    prepare(),
    prepare(ADDRESS, { write: true }),
    prepare(ADDRESS, { write: true, reader: false }),
    op('iterate'),
    op('run', { statement: '1' }),
    op('iterate', { statement: '1' }),
    op('get', { statement: '2' }),
    op('all', { statement: '2' }),
    op('iterate', { statement: '2' }),
    op('run', { statement: '2' }),
    finish(),
    op('get', { statement: '1' }),
    op('all', { statement: '1' }),
    op('run', { statement: '2' }),
    { kind: 'close' },
  ]);
  add('iterator-generations', [
    prepare(),
    op('iterate'),
    next(),
    finish(),
    op('iterate'),
    next(),
    finish(),
    next({ iterator: '1' }),
    finish({ iterator: '1' }),
    op('iterate'),
    next({ iterator: '2' }),
    finish({ iterator: '2' }),
    { kind: 'close' },
  ]);
  for (
    const fault of [
      'callback',
      'callbackReenter',
      'step',
      'row',
      'resetCallback',
      'resetReenter',
      'stepResetCallback',
    ] as Fault[]
  ) {
    add(`iterator-failure-at-exhaustion-${fault}`, [
      prepare(),
      op('iterate'),
      next(),
      next(),
      next(),
      next({ fault }),
      finish(),
      op('get'),
      { kind: 'close' },
    ]);
  }
  for (
    const fault of [
      'resetCallback',
      'stepResetCallback',
      'resetReenter',
    ] as Fault[]
  ) {
    add(`cleanup-callback-early-return-${fault}`, [
      prepare(),
      op('iterate'),
      next(),
      finish({ fault }),
      finish(),
      next(),
      op('get'),
      { kind: 'close' },
    ]);
  }
  for (const kind of ['get', 'all', 'run', 'iterate'] as const) {
    for (const fault of faults) {
      add(`${kind}-${fault}`, [
        prepare(),
        prepare('9007199254740993'),
        op('iterate', { statement: '1' }),
        op(kind, { fault }),
        finish(),
        finish({ statement: '1' }),
        op('all'),
        op('dispose'),
        { kind: 'close' },
      ]);
    }
  }
  for (const kind of ['next', 'return'] as const) {
    for (const fault of faults) {
      add(`iterator-progress-${kind}-${fault}`, [
        prepare(),
        op('iterate'),
        next(),
        op(kind, { iterator: '0', fault }),
        next(),
        finish(),
        finish(),
        op('get'),
        { kind: 'close' },
      ]);
    }
  }
  // Distinct callback and verbose invocations reenter active and already-closed iterators.
  for (
    const fault of [
      'callbackReenter',
      'verboseReenter',
    ] as Fault[]
  ) {
    add(`reentry-distinct-owners-${fault}`, [
      prepare(),
      prepare('9007199254740993'),
      op('iterate'),
      finish(),
      op('iterate'),
      op('all', { statement: '1', fault }),
      next({ iterator: '1' }),
      finish({ iterator: '1' }),
      { kind: 'close' },
    ]);
  }
  return result;
}

/** xorshift32 supplies scheduling only; Lean alone supplies expected behavior. */
export function generated(seed: number): Trace {
  let state = seed >>> 0;
  const random = (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
  const ops: Operation[] = [];
  const choices = [
    'get',
    'all',
    'run',
    'iterate',
    'next',
    'return',
    'dispose',
  ] as const;
  for (let phase = 0; ops.length < GENERATED_STEPS; phase++) {
    // Fresh allocations keep later phases useful even after an early dispose.
    // These numbers schedule handles; they never predict results or events.
    const first = String(phase * 2);
    const second = String(phase * 2 + 1);
    const fault = () => faults[random(faults.length)]!;
    ops.push(
      prepare(String(BigInt(ADDRESS) - BigInt(random(3)))),
      prepare(ADDRESS, { write: random(2) === 1 }),
      op('iterate', { statement: first }),
      next({ statement: first, fault: fault() }),
    );
    for (let index = 0; index < 4; index++) {
      const kind = choices[random(choices.length)]!;
      const statement = random(4) === 0
        ? String(random(phase * 2 + 2))
        : random(2) === 0
        ? first
        : second;
      const operation: Operation = { kind, statement, fault: fault() };
      if (kind === 'next' || kind === 'return') operation.iterator = '0';
      ops.push(operation);
    }
    ops.push(
      finish({ statement: first }),
      op('all', { statement: second, fault: fault() }),
      op('dispose', { statement: first }),
      op('dispose', { statement: second }),
    );
  }
  ops.push({ kind: 'close' });
  return { v: 1, ops };
}
