/** Development-only, versioned wire format shared with the Lean executable. */
export const VERSION = 1;
export const kinds = [
  'prepare',
  'get',
  'all',
  'run',
  'iterate',
  'next',
  'return',
  'dispose',
  'close',
] as const;
export const faults = [
  'none',
  'prepare',
  'partialPrepare',
  'step',
  'row',
  'reset',
  'resetCallback',
  'resetReenter',
  'stepResetCallback',
  'finalize',
  'callback',
  'verbose',
  'callbackReenter',
  'verboseReenter',
] as const;
export type Kind = typeof kinds[number];
export type Fault = typeof faults[number];
export interface Operation {
  kind: Kind;
  statement?: string;
  iterator?: string;
  address?: string;
  fault?: Fault;
  write?: boolean;
  reader?: boolean;
}
export interface Trace {
  v: typeof VERSION;
  ops: Operation[];
}
export interface Event {
  kind: string;
  allocation: string;
  address: string;
}
export interface State {
  open: boolean;
  executing: boolean;
  iterators: string;
  statements: {
    allocation: string;
    address: string;
    live: boolean;
    busy: boolean;
  }[];
}
export interface Observation {
  outcome: string;
  events: Event[];
  state: State;
}
export interface Response {
  v: typeof VERSION;
  steps: Observation[];
}

export function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

/** Reject lossy JSON numbers before they can identify native resources. */
export function parseTrace(value: unknown): Trace {
  if (!value || typeof value !== 'object') throw new Error('Expected trace');
  const trace = value as Record<string, unknown>;
  if (trace.v !== VERSION || !Array.isArray(trace.ops)) {
    throw new Error('Expected protocol v:1 and ops array');
  }
  for (const input of trace.ops) {
    if (!input || typeof input !== 'object') {
      throw new Error('Expected operation');
    }
    const op = input as Record<string, unknown>;
    if (!kinds.includes(op.kind as Kind)) throw new Error('Unknown operation');
    if (op.fault !== undefined && !faults.includes(op.fault as Fault)) {
      throw new Error('Unknown fault');
    }
    for (const key of ['statement', 'iterator', 'address']) {
      if (op[key] !== undefined && !decimal(op[key])) {
        throw new Error(`${key} must be a canonical decimal string`);
      }
    }
    for (const key of ['write', 'reader']) {
      if (op[key] !== undefined && typeof op[key] !== 'boolean') {
        throw new Error(`${key} must be a boolean`);
      }
    }
    if (op.reader === false && op.write !== true) {
      throw new Error('Nonreader fixture requires write:true');
    }
    if (op.kind === 'prepare' && !decimal(op.address)) {
      throw new Error('prepare needs an address label');
    }
    if (
      op.kind !== 'prepare' && op.kind !== 'close' && !decimal(op.statement)
    ) {
      throw new Error(`${String(op.kind)} needs a statement allocation`);
    }
    if ((op.kind === 'next' || op.kind === 'return') && !decimal(op.iterator)) {
      throw new Error(`${String(op.kind)} needs an iterator generation`);
    }
  }
  return trace as unknown as Trace;
}

export async function reference(trace: Trace): Promise<Response> {
  const executable = Deno.env.get('LEAN_LIFECYCLE');
  if (!executable) {
    throw new Error('LEAN_LIFECYCLE is missing; run deno task verify:model');
  }
  const child = new Deno.Command(executable, {
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(trace) + '\n'));
  await writer.close();
  const result = await child.output();
  if (!result.success) {
    throw new Error(
      `Lean reference failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  const response = JSON.parse(
    new TextDecoder().decode(result.stdout),
  ) as Response;
  if (response.v !== VERSION || response.steps?.length !== trace.ops.length) {
    throw new Error(
      'Lean returned a mismatched protocol version or step count',
    );
  }
  return response;
}
