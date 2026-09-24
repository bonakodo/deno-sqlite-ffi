# Lifecycle verification

This development-only project pairs direct Lean 4 proofs with tests that run the
real Deno library against SQLite. The proofs describe the explicit Lean model.
The tests compare a bounded set of library executions with that model. They do
not prove that TypeScript implements the model.

## Commands

From the repository root:

```sh
deno task verify:install
deno task verify
```

The installer downloads Lean 4.28.0 to `build/lean-toolchain/`, checks the release
archive's pinned SHA-256, and leaves shell and computer settings alone. It needs
`curl`, `tar`, and `zstd`. There are no extra Lean packages, npm packages, or Node
runtime dependencies. To use an existing installation, set `LEAN_BIN` to its
`bin` directory. The runner checks its version against `lean/lean-toolchain`.
A missing or wrong version fails verification.
To use a cached release archive, pass its path to `verify:install`; the same
pinned checksum still applies. Installation refuses to overwrite an existing
toolchain directory.

```sh
deno task verify:proofs
deno task verify:model
deno task verify:negative
deno task verify:replay build/verification-failures/NAME.reduced.json
deno task check
deno task test
```

Each verification command cleans and rebuilds the Lean project before running.
The required CI job invokes `verify`, which checks proofs and their axiom
dependencies, exercises the wire format, runs a nonempty real-library trace
suite, and runs the negative controls. It builds the pinned SQLite submodule.
The existing ABI, platform, ownership, compatibility, coverage, and extension
jobs remain in place. Proof work runs once on Linux, outside the platform matrix.

Set `DENO_SQLITE_PATH` to an absolute SQLite shared-library path to reuse a local
build; otherwise the runner builds the pinned submodule. Generated tools, logs,
and failed traces stay under ignored `build/`. Lean build files stay under
ignored `lean/.lake/`. The package publish allowlist remains unchanged.

## Model and source mapping

`lean/Lifecycle/Model.lean` defines the transition system used by both the proof
library and the `lifecycle` executable. A state has one connection, a collection
of statement allocations, iterator ownership, signed iterator count, execution
guard, and native-call histories. Each allocation gets a fresh identity. Address
labels may repeat and never determine allocation identity.

| Model behavior                                                      | TypeScript source                                  |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Prepare, partial allocation cleanup, tracking native calls          | `Connection.prepare` and `Database.prepare`        |
| Open/busy rejection and callback execution guards                   | `Connection.assertIdle`, `step`, `reset`, `log`    |
| Single-row, all-row, and run/reset paths                            | `Statement.get`, `all`, `run`                      |
| Iterator ownership, generations, early/repeated return, row failure | `Statement.iterate`                                |
| Statement disposal and at-most-once finalization                    | `Statement[Symbol.dispose]`, `Connection.finalize` |
| Connection cleanup and repeated close                               | `Database.close`, `Connection.close`               |

Public operations include invalid calls, not just calls with convenient
preconditions. An operation can reject for a closed connection, finalized
statement, busy connection/statement, missing fixture handle, or a non-reader
statement. Missing handles describe invalid references in the trace interface;
JavaScript has no public statement-ID lookup API.

Native outcomes represent success or failure at specified call sites. Rejected
public calls preserve ownership. Per-allocation histories retain step, reset,
and finalize calls, including calls that return errors. This lets the proofs
state ordering properties that a final resource count alone would miss.

The model works at synchronous public-operation boundaries, with explicit
guarded phases for scalar callbacks, verbose handlers, and reset callbacks.
The reset phase observes ownership after iterator release. Its rows are a small
fixed workload, not arbitrary SQL results. Iterator generations distinguish an
old closed iterator from a new iterator on the same statement.

## Claims checked by Lean

The core named theorems are in `lean/Lifecycle/Proofs.lean`:

| Theorem                            | Claim                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `initial_invariant`                | The initial open, empty connection satisfies the invariants.                               |
| `transition_preserves`             | Every modeled operation and failure choice preserves them.                                 |
| `finite_preservation`              | Any finite sequence preserves them, by induction.                                          |
| `allocation_finalize_at_most_once` | A valid allocation history has at most one finalize call.                                  |
| `no_use_after_finalize`            | No later step or reset follows finalization of that allocation.                            |
| `iterator_count_matches_owners`    | The independent signed count equals active owners and is nonnegative.                      |
| `iterator_release_once`            | Release clears ownership, advances the iterator generation, and decrements the count once. |
| `guard_clears`                     | The guarded operation clears its execution flag on normal and exceptional completion.      |
| `reentry_preserves`                | Modeled guarded public reentry preserves the outer state.                                  |
| `cleanup_releases`                 | Allowed explicit connection cleanup releases its live statement allocations.               |

The proof source also covers repeated iterator cleanup and concrete reachable
successful, rejected, and failed traces. `lean/Audit.lean` prints the central
theorems' axiom dependencies. The runner rejects missing audit entries,
`sorryAx`, and every dependency except Lean's ordinary logical principles
`propext`, `Classical.choice`, and `Quot.sound`. These principles concern
proposition equality, choice, and quotients; none assumes SQLite safety.
The source must contain no unproved placeholders or custom safety axioms.

## Reference protocol and tests

`model/protocol.ts` describes protocol version 1. Input has `v: 1` and an `ops`
array. Each output step has an outcome, ordered native events, and an observable
state. Allocation IDs, iterator generations, address labels, and counts use
canonical decimal strings, so values above JavaScript's exact-number range
remain lossless. Both boundaries reject malformed encodings.

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

The adapter instantiates real `Database` and `Statement` objects. It temporarily
wraps native symbols and captures the connection through a test-only prototype
hook. It compares each step against the freshly built Lean executable. It does
not contain a second TypeScript implementation of the transition system.

Faults preserve ownership: prepare failure without allocation returns an error;
partial prepare first creates a valid statement and then reports a synthetic
failure; reset still calls the real reset before returning an injected error;
row conversion throws while the allocation remains live. Native callback and
verbose-handler errors use real JavaScript callbacks. All patched symbols and
hooks restore in `finally`, and each trace cleans up its iterators and database.
Instrumentation runs serially in a separate process from ordinary library tests.

Address reuse uses repeatable virtual address labels over distinct real
allocations. Tests never substitute fake pointers in calls to SQLite and never
depend on an allocator reusing an address or GC running at a chosen time.
Focused traces cover cleanup repetition, distinct owners, write rejection,
non-reader rejection, partial prepare, early exit, exhaustion, failure after
progress, callback throws, and callback reentry. Seeded scheduling adds longer
sequences. `model/cases.ts` records the fixed seeds and operation limits.

On a mismatch, the driver saves the original trace, then performs bounded
deletion reduction with fresh Lean and SQLite state for each candidate. It saves
a reduced replay file (possibly unchanged) under `build/verification-failures/` and prints the exact
replay command. The bound means the reduced case need not be globally minimal.

## Negative controls

`verify:negative` checks two distinct boundaries:

- **Proofs:** isolated Lean source copies omit the iterator decrement or add a
  second finalization. Building them must fail a lifecycle proof. The good model
  must build before either mutation runs.
- **Implementation adapter:** isolated TypeScript source copies omit the real
  iterator decrement or call native finalize twice. The same valid traces must
  pass the real implementation and fail the copies against Lean's expected
  output. A native gate records a duplicate finalization without forwarding a
  freed pointer to SQLite. These controls test semantic differences, not input
  validation.

Each control requires one exact source replacement, rejects an unexpected
successful result, and removes its temporary copy. No broken implementation
remains in the checkout. Proof-control logs stay in
`build/verification-controls/`.

## Assumptions and limits

- SQLite supplies a live statement on successful prepare. A failed prepare
  normally has a null output; the partial-allocation fault models defensive
  cleanup after allocation succeeds but the wrapper reports failure.
- Step and row callbacks respect SQLite's synchronous API contract. Native
  failures return codes; arbitrary FFI exceptions, process termination, and
  corrupted pointers fall outside the model.
- Reset leaves the allocation alive and resets execution even when it returns
  an error. The model preserves current source behavior: `run()` checks that
  return code; cleanup paths for `get`, `all`, and iterators ignore the reset
  code but still propagate stored callback errors where applicable.
- Finalize destroys the allocation even if it reports an earlier execution
  error. The model assumes close-v2 succeeds for a valid connection whose owned
  resources have been released. These are native contracts, not proved facts
  about SQLite. See [reset](https://www.sqlite.org/c3ref/reset.html),
  [finalize](https://www.sqlite.org/c3ref/finalize.html), and
  [close-v2](https://www.sqlite.org/c3ref/close.html).
- The model covers one connection and explicit synchronous cleanup. It does
  not prove SQL parsing, transaction savepoints, async backups, BLOB resources,
  extension behavior, general native memory safety, FFI pointer validity, ABI
  layouts, Deno semantics, or GC timing.
- Parameter getter reentry has a distinct binding-owner rule in TypeScript.
  Dedicated compatibility regressions cover that rule, including allowed calls
  to other statements. It is outside the formal callback model in this phase.
- Tests sample implementation/model agreement. Even exhaustive tests of this
  small workload would not prove that agreement for all TypeScript executions.

## Local validation record

The final validation results, trace counts, benchmark measurements, and commits
are recorded in [the implementation report](../docs/lifecycle-verification.md).
