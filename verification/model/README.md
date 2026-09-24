# Real-library trace adapter

Run the repository's `deno task verify:model`, `deno task verify:negative`, or
`deno task verify:replay <file.json>` tasks. These build the pinned Lean reference
before running this driver. Direct development use requires an absolute
`LEAN_LIFECYCLE` executable path and `DENO_SQLITE_PATH` library path:

```sh
deno run -A verification/model/main.ts run
deno run -A verification/model/main.ts protocol
deno run -A verification/model/main.ts negative
deno run -A verification/model/main.ts replay build/verification-failures/seed-42.reduced.json
```

The driver invokes the Lean executable for every complete trace. Lean's
transition definitions supply every expected per-step outcome, ordered event
list, and final observable state. TypeScript schedules operations, observes the
real library, and compares the results. It contains no second lifecycle model.
These comparisons test agreement on the selected traces; they do not prove
equivalence between TypeScript and Lean.

## Protocol 1

The executable accepts one JSON object per line:

```json
{
  "v": 1,
  "ops": [
    { "kind": "prepare", "address": "18446744073709551601" },
    { "kind": "iterate", "statement": "0" },
    { "kind": "next", "statement": "0", "iterator": "0" },
    { "kind": "return", "statement": "0", "iterator": "0" },
    { "kind": "close" }
  ]
}
```

Operations are `prepare`, `get`, `all`, `run`, `iterate`, `next`, `return`,
`dispose`, and `close`. Prepare accepts `write:true`, with `reader:false` for an
INSERT without RETURNING. Allocation IDs start at zero; successful and partial
prepares consume one ID. Iterator generations start at zero for each statement.
All IDs, address labels, and counts use canonical decimal **strings**, including
values beyond JavaScript's exact integer range. Numbers, signs, exponent
notation, and leading zeroes are rejected. JSON object key order is irrelevant;
array order is significant.

The result is `{"v":1,"steps":[...]}`. Each step contains `outcome`, `events`,
and `state`. Outcomes include the allocation/generation/row value where relevant
(`prepared:0`, `iterator:0`, `row:1`, `rows:1,2,3`, `run:0`, `run:3`) or an explicit error category.
Events record `kind`, `allocation`, and `address`; connection-wide or unsuccessful
allocation events use empty ID/address strings. State records connection open
and executing flags, its iterator count, and every allocation's address, live
flag, and statement busy flag. Native calls retain allocation IDs after cleanup,
so a final-state check cannot hide an extra finalize call.

`run` compares the actual change count with Lean's expected zero for reads or
three for fixture inserts. `RunResult.lastInsertRowid` lies outside this
lifecycle projection: its value depends on the database's accumulated SQL data
state, which this model does not prove. Nor does an operation error imply SQL
side effects rolled back; this phase checks cleanup and ownership on that path.

Native and verbose reentry report six real nested results in event kinds:
`reenter:<prepare|close|get|dispose|next|return>:<outcome>:<guarded|unguarded>`.
The nested operations address the outer statement and the supplied iterator
generation (zero by default). Lean computes those nested outcomes through its
dispatch function. Additional assertions exercise distinct active and closed
iterators and ensure rejected reentry preserves the outer state.

An unknown handle reports `error:missing` at the adapter boundary. Such a handle
has no corresponding JavaScript object, so this is a protocol case, not evidence
about a public library call. Busy, finalized, and closed object tests call the
actual API and compare its errors.

## Safe observations and faults

Each trace uses one real in-memory SQLite database and real Database/Statement
objects. A temporary `Connection.prepare` hook obtains the actual connection;
snapshots read its ownership set, iterator counter, and execution guard, plus
public statement busy flags. Nothing is added to the production execution path.

Read statements select the values 1, 2, and 3 through a registered scalar
callback. Write statements insert those values, with optional RETURNING. Writes
do not use the scalar callback: SQLite evaluates INSERT input callbacks before
it returns rows, unlike a streaming SELECT. `callback` and `callbackReenter`
faults therefore affect read fixtures only. Getter reentry while binding follows
a different ownership rule and remains covered by ordinary regression tests,
outside this Lean model.

This fixture bounds SQL results to those three rows. Empty `get`/`all` results
and general SQL result sets lie outside the model; iterator exhaustion and
nonreader execution cover native DONE transitions. The proofs concern the
modeled lifecycle transitions, not SQLite query planning or SQL semantics.

Fault choices are `none`, `prepare`, `partialPrepare`, `step`, `row`, `reset`,
`resetCallback`, `resetReenter`, `stepResetCallback`, `finalize`, `callback`, `verbose`,
`callbackReenter`, and `verboseReenter`.
Partial prepare first obtains a valid SQLite statement, then reports an error;
the real library must finalize it. Reset/finalize faults call the real cleanup
function before returning an error code, preserving SQLite's resource contract.
Finalize still releases its allocation on error. Reset errors escape `run`;
get/all/iterator cleanup ignores the reset return code, as the source does.
Row failures throw from the intercepted column decoder after a successful step.
Scalar and verbose failures throw from actual user handlers.

`resetCallback` records a pending callback exception on the real connection
after the real reset, matching how a throwing virtual-table cleanup callback
reports its error. `stepResetCallback` also reports a step error, so exceptional
cleanup must suppress the pending callback error and preserve the original
native error. Focused traces check release, repeated cleanup, and a later query
that must not inherit the earlier callback error. Separate repository tests
exercise an actual virtual-table generator throwing from its cleanup.

`resetReenter` runs the six nested API probes while the real reset wrapper holds
the connection guard. Iterator cleanup has already cleared its busy flag and
released its count, so the closing iterator's nested `next` and `return` must
return done; other active iterators still reject. This differs from reentry
during row callbacks, which observes an active owner.

Raw addresses never form allocation IDs. The native observer maps each real
pointer to a fresh allocation, then assigns a decimal address label chosen by
the trace. Labels deliberately repeat across distinct allocations. This safely
tests the reference and comparison boundary's address-reuse handling without
depending on allocator reuse, replacing production pointers, or sending invented
pointers to SQLite. The actual pointer remains the argument to every native call.

Instrumentation runs serially, keeps strong references to objects, and restores
every patched method and symbol in `finally`. It tries every iterator cleanup
and always closes the database, even if a test fails. A native gate blocks
reentrant calls before SQLite if a production guard regresses. A separate gate
records attempted duplicate finalization but never forwards a freed pointer.
Its tracking starts with constructor PRAGMAs, before trace recording. The
repeated-finalize control checks that the gate blocks duplicate calls during
both setup and the trace, and forwards exactly one finalize per real allocation.
The suite does not request GC or depend on finalizer timing.

## Coverage and failures

The suite contains focused lifecycle/fault combinations plus 12 xorshift32 seeds:
`1,7,19,42,73,101,313,997,2026,65537,104729,4294967295`. Each generated trace has
96 scheduled operations and a final close. It creates a fresh pair of allocations
every 12 steps, reuses address labels, mixes valid operations with invalid old or
busy handles, and exercises progress followed by failures and cleanup. The
driver prints the exact focused/total trace and operation counts after success.

On mismatch the driver saves the original trace and a deletion-reduced trace in
`build/verification-failures/`. Reduction tries at most 160 candidates, obtains
new expected results from Lean for each candidate, and executes each in a fresh
database. Replay takes the full JSON operation sequence, so no random state or
generated expected-result file is needed.

The two negative controls first pass against the original implementation. Each
then copies the actual source and adapter into a temporary directory, applies one
exact source edit, and reruns the same trace and Lean comparison in a child Deno
process. The missing-release mutant removes `iterators--`; comparison detects
the wrong real connection count. The repeated-finalize mutant adds a second
native finalize call; comparison detects the extra event while the native gate
prevents a second call into SQLite. Neither control changes the working source.
Malformed-input controls test serialization separately; they do not count as
these real-implementation negative controls.
