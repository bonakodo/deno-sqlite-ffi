# Implementation prompt: Lean proofs and Deno model tests

For an agent configured with Ultra reasoning. The prompt targets direct Lean 4
and tests against the real Deno library. It does not select a model or change
the agent's settings.

---

Implement a complete first phase of formal verification for
`/Users/maratto/_dev/deno-sqlite-ffi`: direct Lean 4 proofs of statement and
iterator lifecycle rules, plus model-based tests that exercise the real library.
Deliver working proofs, tests, CI integration, and documentation. Continue
through implementation and validation; an assessment or an unrun proof sketch
does not complete this task.

## Context and scope

Read `docs/lemmascript-evaluation.md` and the applicable `AGENTS.md` instructions.
The earlier work only tested LemmaScript translation. No Lean or Dafny proofs
have run. Use current source as the authority for existing behavior.

The main code is in `src/api/connection.ts`, `src/api/statement.ts`, and
`src/api/database.ts`. Relevant tests include `test/fault_test.ts`,
`test/ownership_test.ts`, `test/compat/statement_test.ts`, and
`test/compat/callback_errors_test.ts`. Check the build/test scripts and CI before
adding tasks.

Use Lean directly, without LemmaScript. Keep this phase focused on one
connection, multiple statement allocations, iterator ownership, explicit
cleanup, callback reentry, and synchronous failure paths. Leave transaction
savepoint proofs, asynchronous backups, SQL parsing, and general native-memory
proofs for later work.

Preserve the public API, Deno support, package contents, and the runtime's lack
of Node/npm dependencies. Keep Lean and any test dependencies confined to
development and CI. Preserve unrelated work. Make narrow production fixes if
this work reveals a real defect, with a regression case; avoid production
refactors solely to simplify a proof.

## Model and proofs

Create a pinned, reproducible Lean project under an appropriate directory such
as `verification/lean/`. Prefer core/Std facilities and small dependencies.
Use an explicit transition system or Lean's program-verification facilities,
whichever gives the clearest faithful model.

Model allocation identities separately from pointer addresses so that address
reuse cannot hide a double-finalization or use-after-finalization error. Model
connection state, statement state, iterator owners, execution guards, relevant
results/errors, and native lifecycle events. Include:

- Prepare success and failure, including a partial prepare that needs cleanup.
- Statement execution and iterator creation, advancement, exhaustion, early
  return, repeated return, and failure while producing a row.
- Explicit statement disposal and connection close, including repeated cleanup
  and rejected operations on busy or closed resources.
- Callback or verbose-handler throws and attempts to reenter the API.
- Native failures at valid API failure points, and the required cleanup on
  both normal and exceptional exits.

Represent disallowed public operations as explicit rejection outcomes. Do not
exclude them with preconditions just to make proofs pass. Native outcomes may
vary, subject to stated SQLite API contracts. Keep those assumptions separate
from the safety properties being proved.

Prove named theorems establishing:

1. The initial state satisfies the lifecycle invariants.
2. Every modeled transition preserves those invariants, yielding preservation
   over arbitrary finite valid transition sequences.
3. Each statement allocation receives at most one finalize call, and no later
   execution or reset uses that finalized allocation.
4. Iterator counts match active owners and never become negative. Closing an
   iterator releases its ownership once, even across repeated cleanup and
   failure paths.
5. Execution guards clear when the modeled operation completes or throws.
   Reentrant operations reject without corrupting the outer operation's state.
6. Allowed explicit cleanup releases the resources it owns; rejected operations
   do not corrupt ownership. State any needed native assumptions precisely.

Keep event history or equivalent evidence where a final-state check would miss
an invalid native call. Avoid making the invariants hold merely by definition
while omitting the corresponding behavior. Establish reachability of meaningful
successful, rejected, and failed executions.

Require Lean's checker to accept every theorem. Do not use `sorry`, `admit`,
unchecked proof escapes, or custom axioms that assume the desired result.
Audit the central theorems' dependencies for `sorryAx` and unexpected axioms;
document ordinary standard-library logical dependencies. Do not claim that the
model proves Deno, SQLite, the ABI, GC timing, or the TypeScript implementation.

## Connect the model to the real library

Provide a deterministic executable Lean reference or trace generator that uses
the same transition definitions as the proofs. Give it a small, versioned
machine-readable interface for operations, outcomes, lifecycle events, and
observable state. Handle IDs and numeric encoding must be lossless.

Write a Deno test driver that executes corresponding operations on the actual
`Database` and `Statement` implementations with real SQLite. Compare results,
errors, lifecycle events, and the relevant state after each step. Use the Lean
model as the source of expected behavior; a second hand-written TypeScript model
alone is insufficient. Test the serialization and adapter boundary too.

Use seeded generated sequences, with fast-check or an equally suitable small
test-only mechanism. Save failures in a replayable form and reduce them to
useful short sequences. Include invalid operations, distinct statements, address
reuse where it can be simulated safely, early iterator exit, cleanup repetition,
and failures after partial progress. Do not depend on actual allocator address
reuse or nondeterministic GC to cover these rules.

Reuse the repository's safe native fault-injection approach. Never send invalid
pointers to SQLite. Faults must preserve the native API's ownership contract.
Restore patched symbols in `finally`, isolate global instrumentation, and clean
up disposable databases even when a test fails. Keep instrumentation out of the
production execution path where practical.

Add focused negative controls. A deliberate missing iterator release or repeated
finalization must fail a relevant proof or model test. Show that the Deno adapter
detects a wrong real implementation, rather than merely rejecting malformed
input. Run mutations in isolated copies or controlled test fixtures; leave no
broken production variant in the checkout. Report separately what each negative
control validates.

## Tooling, CI, and validation

Pin Lean and dependency versions. Provide simple documented repository commands
for proof checking, model tests, and replaying a failure. Obtain tools in a
project-local or temporary location where practical; do not change unrelated
computer settings. A missing Lean toolchain must fail the required verification
job clearly, never silently skip proofs.

Integrate a bounded, deterministic verification job into the existing CI.
It must check actual theorems and a nonempty set of real-library traces. Keep
the existing ABI, platform, ownership, and compatibility checks. Avoid expanding
the full platform matrix with expensive duplicate proof jobs. Prevent stale
generated traces or binaries from being accepted after model/source changes.

Run the new checks, relevant regressions, `deno task check`, and `deno task test`.
If production execution paths change, run the relevant benchmarks and report
any measured effect. Do not weaken existing checks to accommodate the tools.
Fix failures caused by this work and repeat affected checks. Distinguish local
results from remote CI results.

## Completion and handoff

Document the model, named theorems, assumptions, mapping to source behavior,
test scope, replay commands, and known gaps. State which claims are proved in
Lean and which are supported by tests against TypeScript. Explain that those
tests do not constitute a proof of implementation/model equivalence. Update
`docs/lemmascript-evaluation.md` with the actual outcome.

Commit meaningful completed chunks with Conventional Commits and gitmoji, as
the repository requires. If the signing agent refuses, commit unsigned and
report it. Do not publish, deploy, or run `cdk deploy`.

Finish only when the Lean proofs, real-library model tests, negative controls,
repository checks, and CI configuration are complete and locally validated.
If an external blocker prevents a required check, name the exact blocker and
unfinished requirement; never report an unrun proof as verified.

The final report should list the commits, proved properties, tested behavior,
exact validation commands and outcomes, model-test seeds/counts/limits, remaining
assumptions, and any unrelated uncommitted work.
