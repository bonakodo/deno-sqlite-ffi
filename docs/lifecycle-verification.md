# Lifecycle verification result

Date: September 24, 2026.

The first phase is complete locally: direct Lean proofs, an executable reference,
tests against the actual TypeScript library and SQLite, negative controls, and
CI configuration. Lean proves the model's lifecycle rules. The Deno tests check
agreement on specific executions; they do not prove that TypeScript implements
the model for all executions. No remote CI run, push, publication, or deployment
forms part of this result.

Use the [verification guide](../verification/README.md) for setup and commands,
the [Lean notes](../verification/lean/README.md) for model details, and the
[adapter notes](../verification/model/README.md) for observations and faults.

## Changes and release commit

The local `v0.1.1` tag contains one commit combining the 11 development commits
after `v0.1.0`: the earlier evaluation documents, three ownership fixes, the Lean
model and proofs, reset-reentry proof, real SQLite tests, CI, and this report.
Squashing preserves the validated source, proof, and test files; release edits
update the package version, installation example, and this commit record.

The original development commits contained signatures; Git reported unknown
signer trust locally. No signing refusal required an unsigned fallback. The checkout
started clean, and this work did not encounter unrelated uncommitted changes.
Local tools, logs, and generated files remain ignored under `build/`,
`coverage/`, and `verification/lean/.lake/`.

The production fixes have three focused compatibility regressions:

- An active iterator's `next()` and `return()` reject callback reentry before
  a nested call can release ownership or clear the outer execution guard.
  Already-closed iterators still return done.
- A parameter getter cannot dispose or reuse its statement, or close its
  connection, while native binding needs the statement. Other statements
  retain their existing allowed behavior. A statement-local binding flag and a
  separate connection binding count enforce this rule.
- A getter can open another iterator, so write paths recheck ownership after
  binding. The earlier check alone allowed a getter to bypass the write rule.

The initial binding repair blocked existing calls to other statements from
getters. The full suite caught that compatibility regression; the final repair
uses binding ownership instead of a connection-wide execution guard. The public
API, package publish allowlist, Deno support, and absence of Node/npm runtime
dependencies remain unchanged. Binding getter rules have regression tests but
lie outside this phase's Lean callback model.

## Proved properties

`Lifecycle.transition` dispatches both allowed and rejected operations. It keeps
an independent signed iterator count and all native step/reset/finalize events.
It never filters invalid history to make a proof pass. Fresh allocation IDs
remain distinct when address labels repeat. The executable uses these same
transition definitions, not saved expected outputs.

Lean's checker accepted these named claims:

- `initial_invariant`, `transition_preserves`, `finite_preservation`: initial
  validity and preservation over arbitrary finite modeled operation sequences.
- `allocation_finalize_at_most_once`, `no_use_after_finalize`,
  `reachable_allocation_safety`: at most one finalize per allocation, with no
  step or reset after that finalize.
- `iterator_count_matches_owners`, `iterator_count_is_handle_count`,
  `iterator_release_once`, `repeated_return_preserves`: the count equals active
  owners, stays nonnegative, and repeated cleanup cannot release twice.
- `guard_clears`, `operation_guard_clears`, `reentry_preserves`: completed
  operations clear the guard; nested public operations preserve the outer
  guarded state. Calls on active resources reject, while repeated cleanup of
  already-closed resources can return normally.
- `cleanup_releases`, `statement_cleanup_releases`,
  `repeated_dispose_preserves`, `busy_close_preserves`,
  `busy_statement_preserves`: allowed cleanup releases its resources;
  repeated cleanup and busy rejection preserve ownership as specified.
- `address_reuse_reachable`, `failed_row_releases_reachable`,
  `busy_rejection_reachable`, `partial_prepare_reachable`,
  `callback_reentry_success_reachable`, `callback_throw_reachable`,
  `reset_reentry_observes_released_owner`: concrete successful, rejected, and
  failed traces are reachable. Reset reentry sees the iterator after ownership
  release, so nested cleanup of that same iterator returns done.

The runner audits all 25 names after a clean build. Their dependencies contain
only Lean's standard logical principles `propext`, `Classical.choice`, and
`Quot.sound`. No `sorry`, `admit`, `sorryAx`, custom safety axioms, or unchecked
proof shortcuts appear. The project pins Lean 4.28.0 and has no extra Lean
packages. Some proofs emit unused-simplifier-argument lint warnings; the build
and all theorem checks succeed.

## Real-library test scope

The final suite ran **115 traces and 2,115 operations**: 103 focused traces and
12 generated traces. The fixed xorshift32 seeds are:

```text
1, 7, 19, 42, 73, 101, 313, 997, 2026, 65537, 104729, 4294967295
```

Each generated trace schedules 96 operations and a final close. It introduces
new allocations every 12 steps and includes valid calls, old/missing handles,
busy/finalized rejection, distinct statements, repeated address labels,
and faults after partial progress. Focused traces also cover calls after the
connection closes. Failed traces save complete input JSON;
deletion reduction tries at most 160 candidates with fresh Lean and SQLite
state. That bound does not promise a globally smallest failure.

Each operation compares results/errors, ordered native events, and observable
ownership state with Lean. The focused cases cover prepare failure and partial
cleanup, get/all/run, iterator start/advance/exhaustion/early and repeated
return, row failure, disposal, close, callbacks, verbose handlers, and reset
errors. Reentry compares six actual nested API results and guard snapshots.
Reset callback faults also test suppression of a cleanup error after an earlier
step error and absence of a stale error in a later query.

Protocol checks rejected 14 malformed inputs at both boundaries, retained
decimal values above `2^53`, and verified that an interrupted trace restores
instrumentation and cleans up. IDs and counts use canonical decimal strings.
Missing fixture IDs reject in the adapter; they do not represent a JavaScript
public handle-lookup API.

Native fault wrappers preserve allocation ownership. The adapter uses real
statements, temporary symbol hooks, strong references, and `finally` cleanup.
Repeated virtual address labels test allocation identity without replacing
actual pointers or waiting for allocator reuse or GC. Tests run serially in a
separate process. Test instrumentation does not enter production execution.

## Negative controls and the corrected harness fault

| Control                      | Required failure and observed result                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lean missing release         | Removing the decrement in an isolated model copy leaves unsolved lifecycle proof goals.                                                                                                                                            |
| Lean repeated finalize       | Adding a second recorded finalize in an isolated model copy leaves unsolved lifecycle proof goals.                                                                                                                                 |
| TypeScript missing release   | Removing the real `iterators--` changes the observed connection count. The unchanged trace passes the original implementation and fails the mutant; reduction produced 3 operations from 5.                                        |
| TypeScript repeated finalize | Adding a real second native-finalize call changes the observed event history. The unchanged trace passes the original and fails the mutant; reduction produced 2 operations from 3. The native gate blocks the duplicate before C. |

These controls test proof sensitivity and the adapter's ability to detect a
wrong implementation, separately from malformed-input tests. Every mutation
requires one exact source replacement. Temporary source copies are removed;
the working checkout contains no broken variant.

An early isolated repeated-finalize attempt **did crash**. Its observer started
after `Database` constructor PRAGMAs, so a duplicate setup finalization reached
SQLite. The macOS crash report for PID 99477 at 22:32:40 JST records
`EXC_BAD_ACCESS` / `SIGSEGV`, signal 11, with `sqlite3_finalize` in the stack.
The parent did not retain a numeric Deno exit code for that attempt. This was a
test-harness defect, not a safe negative-control success.

The corrected observer tracks all allocations from the first constructor
prepare. A separate bootstrap preflight now checks the mutated constructor
before the semantic trace. The final repeated-finalize run recorded 3 prepares,
3 forwarded finalizations, and 3 blocked duplicates, including 2 during setup.
The missing-release control recorded 3 prepares, 3 forwarded finalizations,
and no duplicate attempts. Both corrected controls and the full suite passed.

## Local commands and outcomes

Host: Apple M1 Max, macOS arm64; Deno 2.9.6; SQLite 3.53.4 from the pinned
submodule; Lean 4.28.0, commit
`7e01a1bf5c70fc6167d49c345d3bf80596e9a79b`.

Commands ran from the repository root. Where shown, `DENO_SQLITE_PATH` selects
the locally built pinned library by absolute path.

| Command                                                                                                       | Outcome                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno task verify:install build/lean-verified.tar.zst`                                                        | Passed. The full macOS arm64 release archive matched pinned SHA-256 `61942f9d1907db918020154a517c87fb64841e48cebb0032fc0909df8d189a05` before extraction/execution. |
| `deno task verify:install /dev/null`                                                                          | Expected checksum rejection, tested before installation.                                                                                                            |
| `deno task verify:proofs` with no Lean installed                                                              | Expected explicit missing-tool failure; no skipped proof success.                                                                                                   |
| `DENO_SQLITE_PATH="$PWD/build/libsqlite3.dylib" deno task verify`                                             | Passed after a clean Lean build: all proofs, 25 axiom audits, both proof controls, protocol checks, 115 real-library traces, and both source controls.              |
| `DENO_SQLITE_PATH="$PWD/build/libsqlite3.dylib" deno task verify:replay build/verification-replay-smoke.json` | Passed after a clean Lean build: 21 operations from the first focused trace.                                                                                        |
| `deno task check`                                                                                             | Passed formatting, lint, source/script/model type checks, documentation checks, 7 documentation tests, native build, and examples.                                  |
| `DENO_SQLITE_PATH="$PWD/build/libsqlite3.dylib" deno task test`                                               | 77 passed, 0 failed, 1 ignored. The Linux-only ELF check is inapplicable on macOS.                                                                                  |
| `DENO_SQLITE_PATH="$PWD/build/libsqlite3.dylib" deno task coverage`                                           | Passed: 2,501/2,501 source lines, 100% functions, 99.5% branches. This does not measure SQLite C coverage.                                                          |
| `DENO_SQLITE_PATH="$PWD/build/libsqlite3.dylib" deno task bench`                                              | Completed on the baseline and final production code; measurements below.                                                                                            |
| `git diff --check`                                                                                            | Passed.                                                                                                                                                             |

Replay smoke input was created with:

```sh
deno eval 'import { focused } from "./verification/model/cases.ts"; await Deno.writeTextFile("build/verification-replay-smoke.json", JSON.stringify(focused()[0]!.trace, null, 2));'
```

The official Lean download was too slow on this connection. A segmented mirror
download supplied the cached archive; its complete bytes matched the official
release's pinned checksum. The installer then checked those bytes again. CI
uses the official release URL and the pinned Linux checksum. The official
download path on Linux and the remote verification job have not run here.

During development, running native-build checks concurrently raced on generated
`build/sqlite3.c`. Removing that generated file and rerunning the checks in
sequence resolved it. The final checks above ran successfully; no source check
or coverage threshold was weakened.

Ignored local evidence includes `build/verification-complete.log`,
`build/verification-replay.log`, `build/verification-check.log`,
`build/verification-tests.log`, `build/verification-coverage.log`,
`build/verification-bench-full-before.log`, and
`build/verification-bench-final.log`. Proof-mutation diagnostics remain under
`build/verification-controls/`.

## Measured execution cost

These are one before/after run of the existing benchmark suite on the same
host. They show measured effects, not a stable performance bound or proof of
parity. Timing noise and other host activity can affect them.

| Benchmark                      |   Before |    Final |
| ------------------------------ | -------: | -------: |
| Prepared scalar get            |  82.3 ns |  84.5 ns |
| Prepared indexed lookup        | 396.9 ns | 386.5 ns |
| 1 KiB blob read                | 654.6 ns | 662.3 ns |
| 100 updates in one transaction |  61.4 µs |  59.2 µs |
| Scalar JavaScript callback     | 340.4 ns | 358.1 ns |
| Prepared pragma                | 147.8 ns | 141.5 ns |
| 100 rows via all               |  16.4 µs |  16.6 µs |
| 100 rows via iterate           |  18.4 µs |  18.9 µs |

The callback measurement increased about 5.2%; iteration increased about 2.7%.
No performance threshold was added or existing benchmark removed.

## CI and remaining limits

One bounded `ubuntu-24.04` job installs pinned Lean, builds pinned SQLite,
runs `deno task verify`, and retains replay files on failure. It has a 20-minute
timeout and pins Deno 2.9.6. Proof work does not duplicate across the platform
matrix. Existing native, system-library, extension, ABI, compatibility, and
coverage checks remain. Local YAML parsing and job inspection passed; remote
CI is unrun.

Every verification command cleans and rebuilds Lean and checks its version and
theorem dependencies. Missing tools fail clearly. Saved traces and stale
reference binaries cannot satisfy the required CI job. Tools and verification
sources remain development-only, outside the package publish allowlist.

Native assumptions: successful prepare supplies an owned live statement;
step/reset do not free it; reset restores execution even when it reports an
error; finalize consumes it even on an error result; valid close-v2 succeeds
after owned resources are released. Partial prepare injection models defensive
cleanup after a real allocation. The model does not assume arbitrary FFI
exceptions preserve those contracts. The guide links the SQLite contracts.

The model abstracts synchronous operation boundaries, with guarded scalar,
verbose, and reset phases. It does not reproduce every source instruction.
Partial-prepare cleanup, for example, does not hold the TypeScript execution
guard and has no callback in the fixture. Reset probes run after iterator
ownership release. The fixed workload has three integer rows; empty get/all
results, general SQL data, and `lastInsertRowid` lie outside its result
projection. An operation error does not prove that SQL side effects rolled back.

This phase does not prove parameter-getter binding locks, SQL parsing,
savepoints, async backups, BLOB handles, extension behavior, ABI layouts,
pointer validity, Deno, SQLite internals, general native memory safety, GC,
asynchronous interleavings, or TypeScript/model equivalence. Existing tests
still carry those implementation checks where they exist.
