import { execute, type GateReport } from './adapter.ts';
import { focused, generated, GENERATED_STEPS, SEEDS } from './cases.ts';
import { parseTrace, reference, type Trace } from './protocol.ts';

export class Mismatch extends Error {
  constructor(readonly step: number, expected: unknown, actual: unknown) {
    super(
      `Model mismatch at step ${step}\nExpected ${
        JSON.stringify(expected)
      }\nActual   ${JSON.stringify(actual)}`,
    );
  }
}

export async function compare(
  trace: Trace,
  inspectGate?: (report: GateReport) => void,
): Promise<void> {
  const expected = await reference(trace);
  execute(trace, (observation, index) => {
    if (canonical(expected.steps[index]) !== canonical(observation)) {
      throw new Mismatch(index, expected.steps[index], observation);
    }
  }, inspectGate);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')
    }}`;
  }
  return JSON.stringify(value);
}

/** Bounded deletion reduction; each candidate gets fresh Lean and SQLite state. */
export async function reduce(trace: Trace): Promise<Trace> {
  let ops = trace.ops.slice();
  let attempts = 0;
  let width = Math.ceil(ops.length / 2);
  while (width >= 1 && attempts < 160) {
    let changed = false;
    for (let start = 0; start < ops.length && attempts < 160; start += width) {
      const candidate = ops.slice(0, start).concat(ops.slice(start + width));
      if (!candidate.length) continue;
      attempts++;
      try {
        await compare({ v: 1, ops: candidate });
      } catch (error) {
        if (!(error instanceof Mismatch)) throw error;
        ops = candidate;
        changed = true;
        break;
      }
    }
    if (!changed) width = Math.floor(width / 2);
  }
  return { v: 1, ops };
}

async function checked(name: string, trace: Trace): Promise<void> {
  try {
    await compare(trace);
  } catch (error) {
    const directory = new URL(
      '../../build/verification-failures/',
      import.meta.url,
    );
    await Deno.mkdir(directory, { recursive: true });
    const original = new URL(`${name}.json`, directory);
    await Deno.writeTextFile(original, JSON.stringify(trace, null, 2) + '\n');
    const reduced = error instanceof Mismatch ? await reduce(trace) : trace;
    const minimal = new URL(`${name}.reduced.json`, directory);
    await Deno.writeTextFile(minimal, JSON.stringify(reduced, null, 2) + '\n');
    throw new Error(
      `${String(error)}\nReplay: deno task verify:replay ${minimal.pathname}`,
      { cause: error },
    );
  }
}

async function protocol(): Promise<void> {
  const invalid: unknown[] = [
    { v: 2, ops: [] },
    { v: 1, ops: [{ kind: 'bad' }] },
    { v: 1, ops: [{ kind: 'prepare', address: 9007199254740992 }] },
    { v: 1, ops: [{ kind: 'get', statement: '01' }] },
    { v: 1, ops: [{ kind: 'get', statement: '-1' }] },
    { v: 1, ops: [{ kind: 'get', statement: '1e3' }] },
    { v: 1, ops: [{ kind: 'get', statement: 0 }] },
    { v: 1, ops: [{ kind: 'next', statement: '0', iterator: 0 }] },
    { v: 1, ops: [{ kind: 'prepare', address: '1', write: 'true' }] },
    { v: 1, ops: [{ kind: 'prepare', address: '1', reader: false }] },
    { v: 1, ops: [{ kind: 'get', statement: '0', fault: 'unknown' }] },
    { v: 1, ops: [{ kind: 'prepare' }] },
    { v: 1, ops: [{ kind: 'get' }] },
    { v: 1, ops: [{ kind: 'next', statement: '0' }] },
  ];
  for (const value of invalid) {
    let failed = false;
    try {
      parseTrace(value);
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new Error('TypeScript protocol accepted malformed input');
    }
    failed = false;
    try {
      await reference(value as Trace);
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new Error(
        `Lean protocol accepted malformed input: ${JSON.stringify(value)}`,
      );
    }
  }
  await compare(parseTrace({
    v: 1,
    ops: [
      { kind: 'prepare', address: '18446744073709551615' },
      { kind: 'get', statement: '9007199254740993' },
      { kind: 'return', statement: '0', iterator: '18446744073709551615' },
      { kind: 'close' },
    ],
  }));
  const cleanupTrace = parseTrace({
    v: 1,
    ops: [
      { kind: 'prepare', address: '7' },
      { kind: 'iterate', statement: '0' },
      { kind: 'next', statement: '0', iterator: '0' },
      { kind: 'return', statement: '0', iterator: '0' },
      { kind: 'close' },
    ],
  });
  const interrupted = new Error('Intentional comparison interruption');
  let caught = false;
  try {
    execute(cleanupTrace, (_observation, index) => {
      if (index === 2) throw interrupted;
    });
  } catch (error) {
    if (error !== interrupted) throw error;
    caught = true;
  }
  if (!caught) throw new Error('Adapter interruption fixture did not run');
  await compare(cleanupTrace);
  console.log(
    `Protocol: ${invalid.length} malformed cases rejected by both boundaries; decimal values above 2^53 retained; interrupted trace cleanup restored instrumentation`,
  );
}

async function copyDirectory(from: URL, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = new URL(entry.name + (entry.isDirectory ? '/' : ''), from);
    const target = `${to}/${entry.name}`;
    if (entry.isDirectory) await copyDirectory(source, target);
    else if (entry.isFile) await Deno.copyFile(source, target);
    else throw new Error('Unexpected symlink in mutation source');
  }
}

async function negative(): Promise<void> {
  const root = new URL('../../', import.meta.url);
  const controls = [
    {
      name: 'missing-release',
      file: 'src/api/statement.ts',
      before: 'this.#connection.iterators--;',
      after: '/* Deliberate negative control: omit ownership release. */',
      ops: [
        { kind: 'prepare', address: '99' },
        { kind: 'get', statement: '0' },
        { kind: 'iterate', statement: '0' },
        { kind: 'next', statement: '0', iterator: '0' },
        { kind: 'return', statement: '0', iterator: '0' },
      ],
    },
    {
      name: 'repeated-finalize',
      file: 'src/api/connection.ts',
      before: 'this.sql.sqlite3_finalize(statement);\n      } finally',
      after:
        'this.sql.sqlite3_finalize(statement);\n        this.sql.sqlite3_finalize(statement);\n      } finally',
      ops: [
        { kind: 'prepare', address: '99' },
        { kind: 'get', statement: '0' },
        { kind: 'dispose', statement: '0' },
      ],
    },
  ] as const;
  for (const control of controls) {
    const trace = parseTrace({ v: 1, ops: control.ops });
    await compare(trace);
    const directory = await Deno.makeTempDir({
      prefix: 'sqlite-model-mutation-',
    });
    try {
      await copyDirectory(new URL('src/', root), `${directory}/src`);
      await copyDirectory(
        new URL('verification/model/', root),
        `${directory}/verification/model`,
      );
      for (const file of ['deno.jsonc', 'deno.lock']) {
        await Deno.copyFile(new URL(file, root), `${directory}/${file}`);
      }
      const path = `${directory}/${control.file}`;
      const source = await Deno.readTextFile(path);
      if (source.split(control.before).length !== 2) {
        throw new Error(
          `Mutation no longer has one exact source target: ${control.name}`,
        );
      }
      await Deno.writeTextFile(
        path,
        source.replace(control.before, control.after),
      );
      await Deno.writeTextFile(
        `${directory}/trace.json`,
        JSON.stringify(trace),
      );
      const output = await new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '-A',
          'verification/model/main.ts',
          'mutation-child',
          'trace.json',
          control.name,
        ],
        cwd: directory,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      const stdout = new TextDecoder().decode(output.stdout);
      if (
        !output.success ||
        !stdout.includes('REAL_IMPLEMENTATION_MUTATION_DETECTED')
      ) {
        throw new Error(
          `Negative control did not detect ${control.name} (exit ${output.code}): ${stdout}\n${
            new TextDecoder().decode(output.stderr)
          }`,
        );
      }
      const detail = stdout.match(
        /reduced (\d+) -> (\d+) operations; gate (\{[^\n]+\});/,
      );
      if (!detail) {
        throw new Error('Negative child omitted reducer/gate evidence');
      }
      console.log(
        `Negative control ${control.name}: real source mutant rejected; original passes; reduced ${
          detail[1]
        } -> ${detail[2]}; gate ${detail[3]}`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
}

async function main(): Promise<void> {
  const command = Deno.args[0] ?? 'run';
  if (command === 'replay' || command === 'mutation-child') {
    const path = Deno.args[1];
    if (!path) throw new Error('Replay requires a JSON trace file');
    const trace = parseTrace(JSON.parse(await Deno.readTextFile(path)));
    if (command === 'mutation-child') {
      if (Deno.args[2] === 'repeated-finalize') {
        // Exercise only constructor/setup duplicate intent first. This safety
        // control is separate from the Lean-backed semantic comparison below.
        let bootstrap: GateReport | undefined;
        execute({ v: 1, ops: [] }, undefined, (report) => {
          bootstrap = report;
        });
        if (
          !bootstrap || bootstrap.prepared < 1 ||
          bootstrap.prepared !== bootstrap.forwardedFinalizes ||
          bootstrap.bootstrapBlockedFinalizes !== bootstrap.prepared
        ) {
          throw new Error(
            `Bootstrap gate did not suppress every duplicate: ${
              JSON.stringify(bootstrap)
            }`,
          );
        }
      }
      let gateReport: GateReport | undefined;
      try {
        await compare(trace, (report) => {
          gateReport = report;
        });
      } catch (error) {
        if (!(error instanceof Mismatch)) throw error;
        if (Deno.args[2] === 'repeated-finalize') {
          if (
            !gateReport || gateReport.bootstrapBlockedFinalizes < 1 ||
            gateReport.blockedDuplicateFinalizes <=
              gateReport.bootstrapBlockedFinalizes ||
            gateReport.forwardedFinalizes !== gateReport.prepared
          ) {
            throw new Error(
              `Native gate failed bootstrap/trace safety check: ${
                JSON.stringify(gateReport)
              }`,
            );
          }
        }
        const smaller = await reduce(trace);
        if (smaller.ops.length >= trace.ops.length) {
          throw new Error(
            'Reducer did not remove irrelevant operations from mutation fixture',
          );
        }
        let replayFailed = false;
        try {
          await compare(smaller);
        } catch (replayError) {
          if (!(replayError instanceof Mismatch)) throw replayError;
          replayFailed = true;
        }
        if (!replayFailed) {
          throw new Error('Reduced mutation replay no longer fails');
        }
        console.log(
          `REAL_IMPLEMENTATION_MUTATION_DETECTED reduced ${trace.ops.length} -> ${smaller.ops.length} operations; gate ${
            JSON.stringify(gateReport)
          }; ${error.message}`,
        );
        return;
      }
      throw new Error(
        'Deliberately wrong implementation matched the Lean model',
      );
    }
    await compare(trace);
    console.log(`Replay passed: ${trace.ops.length} operations`);
  } else if (command === 'negative') await negative();
  else if (command === 'protocol') await protocol();
  else if (command === 'run') {
    await protocol();
    let count = 0;
    const cases = focused();
    for (const { name, trace } of cases) {
      await checked(name, trace);
      count += trace.ops.length;
    }
    for (const seed of SEEDS) {
      const trace = generated(seed);
      await checked(`seed-${seed}`, trace);
      count += trace.ops.length;
    }
    console.log(
      `Model tests: ${
        cases.length + SEEDS.length
      } traces, ${count} operations; ${cases.length} focused traces; seeds ${
        SEEDS.join(',')
      }; generated limit ${GENERATED_STEPS} plus close; reducer limit 160 attempts`,
    );
  } else throw new Error(`Unknown command ${command}`);
}

if (import.meta.main) await main();
