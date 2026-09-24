# Lean lifecycle model

This is a direct Lean 4.28.0 development project. It imports only the pinned
Lean distribution's core, `Std`, and JSON support. `Main.lean` calls the same
`Lifecycle.transition` function checked by the proofs. It does not read a saved
set of expected traces.

## State and scope

One open connection starts with no statements. The connection owns a list of
allocation records. A record's index is its permanent allocation identity;
`address` is a separate natural-number label. A later allocation can use the
same address. A failed partial prepare consumes an identity and records its
finalization, but does not expose a public statement handle.

Each statement has a live flag, an iterator owner flag, and a completed-iterator
counter. An iterator handle consists of the allocation identity and generation.
The current generation is active only while the owner flag is set. Earlier
generations are closed handles, and future generations are missing handles.
The connection also stores an **independent signed iterator count**. Opening
and closing an iterator change that count by `+1` and `-1`; proofs check those
updates against the list of active owner handles.

Every modeled step, reset, and finalize call is kept in its allocation's
newest-first history. `record` appends calls without testing whether the
resulting history is valid. `History` describes a separate native lifecycle
specification: step and reset require a live allocation, and finalize changes
it to dead. The preservation proof shows that dispatch produces such histories.
It does not sanitize, discard, or repair calls to make a history pass.

`dispatch` includes public validation and explicit rejection outcomes. It
covers prepare; get, all, and run; iterator creation, next, and return; statement
disposal; and connection close. Invalid resource operations stay in the input
space. Reader and writer flags cover read-only scans, writes returning rows,
and writes without rows. Fixtures use three fixed integer rows; this phase does
not model arbitrary SQL results or data changes. `run` compares the fixture's
change count (`0` for reads, `3` for writes); `lastInsertRowid` is outside the
lifecycle comparison.

Native callbacks and verbose handlers use guarded internal phases. A phase sets
`executing`, dispatches nested public operations, uses their returned state, and
clears the guard for both normal and error results. The outer transition uses
the state returned by those phases. Its events contain the actual nested
outcome and guard snapshot for prepare, close, get, dispose, next, and return.
These expected observations drive the Deno comparison.

This is an atomic synchronous abstraction. Internal phases use a uniform guard
for native events; this is not the exact source instruction timeline. In
particular, partial-prepare cleanup directly finalizes its never-executed
allocation without setting `executing` in TypeScript. The adapter observes
guards during the scalar/verbose callback sites and after API completion.
The event plan determines callback
sites. Step and verbose probes run before the outer state update. Reset
probes run after the cleanup state update, so nested next/return see a closed
iterator after its ownership is released. The proof that nested operations
preserve each phase's state justifies this atomic schedule within the model. It does not prove arbitrary instruction interleavings, asynchronous
calls, or the TypeScript scheduler. Binding getters use a different lock policy
and are outside this model; focused TypeScript regression tests cover them.

## Named claims

- `initial_invariant`: initial ownership and native histories are valid.
- `transition_preserves`: every operation and modeled outcome preserves the
  invariant; no operation preconditions exclude invalid public input.
- `finite_preservation`: induction extends preservation to any finite sequence.
- `allocation_finalize_at_most_once`, `no_use_after_finalize`, and
  `reachable_allocation_safety`: each retained allocation history contains at
  most one finalize and no later step or reset.
- `iterator_count_matches_owners` and `iterator_count_is_handle_count`: the
  signed count equals the number of active owner handles and is nonnegative.
- `iterator_release_once` and `repeated_return_preserves`: closing releases the
  owner and decrements once; an earlier closed generation leaves state intact.
- `reentry_preserves`: dispatch under an already-held execution guard preserves
  the complete outer state, including its guard. Repeated cleanup can return
  normally, while operations on active resources reject.
- `guard_clears` and `operation_guard_clears`: normal and exceptional guarded
  phases clear their guard, as does every complete reachable API operation.
- `cleanup_releases` and `statement_cleanup_releases`: allowed explicit cleanup
  releases the allocations it owns. `repeated_dispose_preserves` checks that
  repeated disposal leaves state intact.

`Reachability.lean` checks concrete successful, rejected, and failed executions,
including reused addresses, partial prepare cleanup, row failure after progress,
callback throws, and guarded callback reentry. These examples supplement the
unbounded sequence proof; they do not replace it.

`Audit.lean` prints dependencies of the central theorems. The repository runner
checks the expected theorem list and rejects `sorryAx` and unexpected axioms.
Ordinary Lean logical dependencies such as `propext`, `Quot.sound`, and
`Classical.choice` are acceptable; they are logical foundations, not lifecycle
assumptions. There are no custom axioms, proof placeholders, native-decision
proof shortcuts, or generated proof stubs.

## Native contracts and limits

The model assumes native calls are synchronous and their return-code failures
obey the ownership contracts below. It does not assume an arbitrary JavaScript
FFI wrapper can throw after silently allocating a handle. A successful prepare returns
one new owned allocation. A failed prepare returns no allocation, or a partial
owned allocation that the wrapper must finalize. A step/reset error does not
free the statement. Finalize consumes the allocation even when it reports the
last execution's error. A valid `sqlite3_close_v2` releases the connection after
its owned statements have been finalized. Injecting a close failure while
pretending that it freed the connection is not a supported contract.

`run` checks reset's result; get/all/iterator cleanup ignore its numeric result,
as the source does. A reset callback may throw; an earlier step failure takes precedence over a
callback failure during suppressed cleanup. Reset reentry observes the already
released iterator owner, and repeated cleanup returns done. Callback errors and row-production exceptions still require
reset and owner release. The fixed write fixture has no native function callback,
so native callback faults on that fixture have no effect. Verbose faults affect
all statement starts; iterator next/return do not run the verbose handler.

These are assumptions and test-fixture choices, not propositions about SQLite,
Deno FFI, the ABI, or TypeScript. The proofs do not cover GC timing, binding
getter locks, parameter conversion, SQL parsing, transactions/savepoints,
asynchronous backups, or general native memory. Model tests support agreement
on their finite inputs; they do not prove implementation/model equivalence.

## Wire format

The executable accepts one JSON object per line and emits one JSON response per
line. Each request starts from a fresh state:

```json
{
  "v": 1,
  "ops": [
    { "kind": "prepare", "address": "17" },
    { "kind": "iterate", "statement": "0" },
    { "kind": "next", "statement": "0", "iterator": "0" },
    { "kind": "return", "statement": "0", "iterator": "0" },
    { "kind": "close" }
  ]
}
```

Operations are `prepare`, `get`, `all`, `run`, `iterate`, `next`, `return`,
`dispose`, and `close`. Optional `fault` selects `none`, `prepare`,
`partialPrepare`, `step`, `row`, `reset`, `finalize`, `callback`, `verbose`,
`callbackReenter`, `verboseReenter`, `resetCallback`, `stepResetCallback`, or
`resetReenter`. Optional `write` and `reader` flags apply
to prepare; a non-reader fixture requires `write:true`. All IDs and address
labels are canonical decimal **strings**, including values above `2^53`.
Numbers, negative strings, exponents, and leading zeroes are rejected. Unknown
versions, operations, and faults fail with a nonzero process exit.

The response has `v:1` and a `steps` array. Each entry has an outcome string,
ordered events, and observable state: connection open/guard flags, signed count
as a string, and allocation records with identity, address, live, and busy flags.
JSON object member order is not significant. Array and event order is significant.
