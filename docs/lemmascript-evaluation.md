# LemmaScript evaluation

Date: September 24, 2026. Library revision:
`22ab9adf86c1c1bcb9b786dc17dc95dc259c566f`.

## Follow-up: direct Lean verification completed

Later on September 24, 2026, the first lifecycle phase used Lean directly,
without LemmaScript. Lean 4.28.0 checked the transition-preservation proofs and
25 named theorem dependency audits. A Deno adapter compared 115 traces (2,115
operations) on the real SQLite library with a freshly built Lean reference.
Both proof mutations and both real-source mutations failed as expected.

The work also fixed iterator callback reentry and parameter-getter ownership
defects, retained the public API and runtime dependencies, and added one Linux
verification CI job. Local repository checks, tests, coverage, replay, and
benchmarks ran. Remote CI has not run for these commits.

These results establish properties of the Lean model and tested agreement with
TypeScript on the chosen traces. They do not prove implementation/model
equivalence, SQLite, Deno, native memory, or GC behavior. See the
[verification guide](../verification/README.md) and
[full result report](lifecycle-verification.md) for the claims, assumptions,
commands, measurements, and a corrected failure in the initial mutation harness.

The rest of this document records the earlier LemmaScript-only evaluation.
Its statements about unrun proofs and unchanged production code describe that
earlier work, not this follow-up.

## Recommendation

Defer broad adoption. LemmaScript could check a small set of pure decisions in
this library, but it does not currently fit the code responsible for native
memory, callback lifetimes, exception cleanup, and asynchronous backups. Those
parts carry much of this library's risk.

A short trial could establish a useful proof workflow. It would not justify
calling the library formally verified. For the next reliability investment,
prioritize generated compatibility cases, native fault injection, and resource
lifetime checks. Keep the current platform and ABI tests.

## What was checked

- Read the API, native loading and memory code, CI, and relevant regression tests.
- Checked the current official documentation and npm release metadata.
- Installed `lemmascript@0.6.4` in a temporary directory with lifecycle scripts
  disabled. The npm release dates to September 19, 2026; the upstream `main`
  revision was `097f18f6bb6ca85c604441bb0aa66b9b11678063`.
- Ran the Dafny code generator on isolated copies and small extracted examples
  under Node 26.8.2 on macOS arm64. Inspected the generated files.
- Attempted `lsc check`. It stopped because `dafny` was absent from `PATH`.
  An attempted temporary download of Dafny 4.11.0 did not finish within the
  evaluation window. **No Dafny proof passed or failed in this evaluation.**

Production code, runtime dependencies, and CI did not change. The examples below
assess translation and modeling, not end-to-end correctness. No library tests or
benchmarks were rerun for this documentation-only change.

## Fit with this library

LemmaScript adds contracts in TypeScript comments and translates selected
functions into proof code. Its current release describes itself as a tech
preview. Dafny offers the most relevant LemmaScript backend support here,
including class methods. Direct Lean modeling is a separate option; see the
comparison below.
Sources: [project README](https://github.com/midspiral/LemmaScript/tree/097f18f6bb6ca85c604441bb0aa66b9b11678063),
[design](https://docs.lemmascript.org/design/),
[installation](https://docs.lemmascript.org/installation/).

| Area                                                | Feasibility now                                                                          | Likely value and cost                                                                                                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed int64 limits in `validation.ts`              | Good for a new, typed boolean helper; poor for the existing `unknown`/throwing validator | Small, clear contract, but boundary tests already cover a simple rule. Low added value.                                                                                                              |
| Row-mode choice in `Statement.#setMode`             | Good after extracting the pure choice                                                    | Useful first exercise; only 32 combinations of two four-value modes and a boolean. Exhaustive tests are cheaper.                                                                                     |
| Parameter assignment in `values.bind`               | Plausible after separating the assignment plan from native binding                       | Best potential target: prove each slot gets the right named or positional value and consumes each positional argument once. Refactoring, JavaScript object behavior, and allocation costs need care. |
| SQL-tail recognition in `hasSql`                    | Current regex does not translate                                                         | A scanner could support proofs, but it needs a precise contract for SQLite's accepted tails and comparison tests against SQLite. Do not rewrite it just to satisfy the tool.                         |
| Statement, iterator, and transaction cleanup        | Poor for the current implementation                                                      | High-value properties, but nested callbacks, exceptions, shared state, and native calls prevent a small proof effort.                                                                                |
| Text/blob storage, callbacks, and virtual-table ABI | Poor                                                                                     | A proof over a hand-written model would leave pointer validity, buffer ownership, callback lifetime, and ABI layout as assumptions.                                                                  |
| Backup retries, progress, and cancellation          | Poor                                                                                     | Real `await`, cleanup, native state, and JavaScript numeric behavior all matter.                                                                                                                     |
| Generated row readers and their cache               | Poor for the full path                                                                   | A pure cache policy might fit. That would not prove the `new Function` output, property behavior, or the native reads correct.                                                                       |

Code references: [validation](../src/api/validation.ts),
[binding](../src/api/values.ts), [statements](../src/api/statement.ts),
[transactions](../src/api/database.ts), [connections](../src/api/connection.ts),
[memory](../src/native/memory.ts), [callbacks](../src/api/functions.ts),
[virtual tables](../src/api/tables.ts), [backup](../src/api/backup.ts),
[row readers](../src/api/rows.ts).

## Local translation results

Each example used `lsc gen --backend=dafny <file.ts>` with version 0.6.4.
The source copies stayed outside the repository.

| Input                                                             | Observed result                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual `hasSql` body, with `//@ verify`                           | Exit 1: unsupported regular-expression literal.                                                                                                                                                                                                                              |
| Actual `integer` validator, with `//@ verify`                     | Exit 0, but emitted an abstract `Unknown` parameter, `typeof(value)`, numeric comparisons on that abstract value, a boolean return slot for the TypeScript assertion signature, and `assert false` for the throw. Generation success does not establish a valid proof model. |
| Typed `bigint` version of the throwing validator                  | Exit 0; out-of-range inputs reach generated `assert false`. This models a demand that the throw is unreachable, not a contract that invalid input throws.                                                                                                                    |
| New pure `fitsInt64(value: bigint): boolean`                      | Exit 0; exact integer bounds and two postconditions appear in the generated Dafny.                                                                                                                                                                                           |
| Same helper with the upper bound raised by one                    | Exit 0 too. Generation alone cannot distinguish this bug; a prover run must reject it.                                                                                                                                                                                       |
| Pure version of the row-mode selection expression                 | Exit 0; four enum cases and all three postconditions appear in Dafny.                                                                                                                                                                                                        |
| Small class method that clears `executing` in `finally`           | Exit 1: unsupported `try` statement.                                                                                                                                                                                                                                         |
| Small async function containing `await Promise.resolve()`         | Exit 1: unsupported await expression.                                                                                                                                                                                                                                        |
| Encoder, scratch buffer, and `encodeText` copied from `memory.ts` | Exit 1: unsupported `new TextEncoder()`. An earlier isolated body probe also rejected `new Uint8Array(2 ** Math.ceil(Math.log2(capacity)))`.                                                                                                                                 |
| `number` increment at `9007199254740992`                          | Exit 0; generated integer addition, which does not preserve JavaScript rounding.                                                                                                                                                                                             |

The successful generation command for the pure bounds example produced:

```text
Generated: .../int64.dfy.gen
Created: .../int64.dfy
```

The subsequent check reported:

```text
Running dafny verify...
ERROR: `dafny` not found on PATH — verification never ran. Install Dafny 4.x: https://dafny.org/
```

## Limits that affect the value of a proof

**Floating point:** LemmaScript models `number` with mathematical integers or
exact reals. SQLite number conversion, `NaN`, rounding, and backup progress
therefore need runtime tests. In the local probe, `value + 1` at `2^53` became
integer addition; JavaScript returns the same number. `bigint` range checks
avoid this particular mismatch.

**Exceptions:** Throwing becomes `assert false`; the local `try`/`finally`
example failed extraction. Preconditions that exclude invalid inputs would not
prove public input rejection or cleanup after failure.

**External calls:** Cross-file calls default to trusted, deterministic functions.
Impure externs permit differing results but do not model shared heap changes.
Treating `sqlite3_step`, reset, or close as ordinary pure calls would omit their
key effects. Declaring a native contract does not prove SQLite or Deno meets it.

**Proof scope:** Selecting functions, abstracting unsupported expressions, or
adding assumptions can leave the hardest behavior outside the claim. Review
those boundaries along with the stated contract.

These are documented model limits, reinforced by the local probes, rather than
bugs found in this library. Source:
[specification](https://docs.lemmascript.org/spec/) sections 2.6, 2.9–2.12, 4.1,
and 9.

## Adoption cost

Comment contracts would not add runtime work or change the package's public API.
A developer-only Node/Dafny workflow can coexist with the Deno package. The
[publish allowlist](../deno.jsonc) already limits shipped files, so proof files
could live outside `src/`.

There is still tool and review cost:

- Pin LemmaScript, its npm dependency lock, and the Dafny version. The temporary
  install added 241 packages; this is a development tool, not a runtime need.
- Supply the relevant TypeScript settings explicitly. Inspection of 0.6.4's CLI
  showed discovery of `tsconfig.json`, not `deno.jsonc`. Its fallback does not
  reproduce this project's `noUncheckedIndexedAccess` setting or Deno globals.
- Keep generated `.dfy.gen` files and proof additions in `.dfy` in sync. Review
  the translation and assumptions as well as the contract. A sound backend
  proves the translated model; it does not validate the translator itself.
- Run actual verification in CI and require a nonempty set of intended targets.
  Check imported helpers too; a caller's proof can otherwise rely on an
  unproved helper contract. Do not accept generation-only checks as proofs.
- Benchmark any extraction that changes binding, row reading, or encoding.
  These paths already avoid allocations and repeated native metadata calls.

Sources: [Dafny workflow](https://docs.lemmascript.org/spec-dafny/),
[existing-code guide](https://docs.lemmascript.org/getting-started/), and
[0.6.4 CLI source](https://github.com/midspiral/LemmaScript/blob/097f18f6bb6ca85c604441bb0aa66b9b11678063/tools/src/lsc.ts).

As a planning estimate, allow half a day to one day for a tiny proof trial after
the prover works. A useful parameter-assignment extraction could take several
days including compatibility and performance checks. This evaluation did not
measure proof authoring time; it offers no credible estimate for full resource
lifetime verification.

## A bounded next step

If proof tooling is itself worth exploring, cap the first trial at one day:

1. Prove the typed int64 predicate and row-mode selector with no extra assumptions.
   Keep their purpose modest: establish the workflow.
2. Run wrong-bound and wrong-mode mutations and require proof failure. Keep the
   existing throwing wrappers and test their invalid-input behavior.
3. Only then consider a pure parameter-assignment function that production code
   actually calls. Specify named/positional order, missing and excess arguments,
   and flattening behavior. Compare results against the current implementation.
4. Stop if the work needs translator patches, broad rewrites, or assumptions
   that restate the desired result. Stop if binding performance regresses.

A successful trial would establish a few explicit claims about real helpers.
It would not replace [fault tests](../test/fault_test.ts),
[ABI checks](../test/abi_test.ts), [ownership checks](../test/ownership_test.ts),
[transaction regressions](../test/compat/transaction_test.ts), or
[value conversion tests](../test/compat/value_conversion_test.ts).
The current [CI definition](../.github/workflows/test.yml) already exercises
multiple operating systems, architectures, Deno versions, and SQLite builds.
This evaluation reviewed that definition; it did not verify current remote runs.

## Reproducible minimal trial

Install the CLI in a separate directory and put Dafny 4.x on the command's
`PATH`, then save this as `int64.ts` there:

```ts
export function fitsInt64(value: bigint): boolean {
  //@ verify
  //@ ensures \result ==> -9223372036854775808n <= value && value <= 9223372036854775807n
  //@ ensures !\result ==> value < -9223372036854775808n || value > 9223372036854775807n
  return value >= -9223372036854775808n && value <= 9223372036854775807n;
}
```

Run from that directory:

```sh
npm install --ignore-scripts --no-audit --no-fund lemmascript@0.6.4
./node_modules/.bin/lsc gen --backend=dafny int64.ts
./node_modules/.bin/lsc check --backend=dafny int64.ts
```

For the negative control, create a fresh file with the same contract and change
only the return expression's upper bound to `9223372036854775808n`. Verification
must fail. The helper is a proposed extraction, not existing production code.

## Lean and other options

Follow-up assessment, September 24, 2026: direct Lean is feasible for proofs
about resource state changes. The earlier blockers concern LemmaScript's
TypeScript translation and chosen model; they are not limits of Lean's logic.
Changing only the backend does not address them.

### Switching LemmaScript to Lean

Repeated five local probes with `lsc gen --backend=lean` on version 0.6.4:

| Probe                   | Result                                    |
| ----------------------- | ----------------------------------------- |
| Pure int64 predicate    | Generated Lean definitions and contracts. |
| Pure row-mode selector  | Generated Lean definitions and contracts. |
| SQL-tail regex          | Rejected the same regex literal.          |
| `try`/`finally` cleanup | Rejected the same try statement.          |
| Real `await`            | Rejected the same await expression.       |

No Lean checker ran: `lean`, `lake`, and `elan` were absent from `PATH`.
The generated files are not checked proofs. The Lean backend also lacks the
class and impure-extern support available in LemmaScript's Dafny backend, so it
does not improve the fit for the current classes and native calls.
Sources: [Lean backend](https://docs.lemmascript.org/spec-lean/),
[shared specification](https://docs.lemmascript.org/spec/).

### Direct Lean

Write an explicit state model in Lean, define each allowed transition, and prove
that all transitions preserve the required rules. Induction can then cover
arbitrary finite sequences, rather than a fixed number of operations. Lean's
`Std.Do` framework also supports reasoning about state and both normal and
exceptional results of Lean programs. Sources:
[program verification](https://lean-lang.org/doc/reference/latest/The--mvcgen--tactic/),
[state and exception conditions](https://lean-lang.org/doc/reference/latest/The--mvcgen--tactic/Predicate-Transformers/).

This could express the properties that matter here: no repeated finalization
of one allocation, no native use of a finalized statement, consistent iterator
counts, and release of execution guards on error. Model native return codes and
callback failures as explicit choices. Track allocation identities rather than
raw pointer numbers, which native allocation can reuse.

The cost is correspondence with production. A correct Lean model does not prove
the TypeScript implements it. Replaying operation sequences against Deno can
check that correspondence on many cases. A full proof would additionally need
formal TypeScript/Deno semantics and a proof connecting the implementation to
the model, or a reviewed code-generation route. None of that exists in this
repository today. SQLite, Deno FFI, and the native ABI would still need explicit
assumptions. Do not claim guaranteed GC cleanup or backup completion when the
environment may indefinitely delay collection or hold a lock.

### Framework comparison

These fit judgments follow from this repository's code. Except for the
LemmaScript generation probes above, they are a documentation assessment, not
completed integrations.

| Tool                             | What it could establish here                                                                                             | Cost and recommendation                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct Lean                      | General theorems about a precise lifecycle or binding model                                                              | High proof and maintenance effort; worthwhile if machine-checked theorems are the goal. Start with statement/iterator cleanup.                    |
| Quint with TLC, or TLA+ with TLC | Exhaustive checks of a finite state model, including operation order and failures                                        | Best first formal model for this library. Constrain the number of handles and states, then replay model traces against Deno.                      |
| fast-check model-based tests     | Whether generated command sequences on the real library agree with a simpler model; shrinks failures and supports replay | Best immediate implementation-level fit. It provides test evidence, not a universal proof.                                                        |
| Gillian-JS                       | Symbolic execution and verification of its supported JavaScript model                                                    | Its repository identifies the frontend as ES5. Modern Deno features and FFI would need substantial translation/modeling work; not a first choice. |
| Verus                            | Proofs about supported Rust code                                                                                         | Relevant to a future Rust implementation; adoption here would mean a major rewrite or new native component.                                       |
| Frama-C/WP                       | Contract proofs for C code                                                                                               | Relevant to a C adapter or selected C routines. It does not check the existing TypeScript wrapper.                                                |

Sources: [Quint model checkers](https://quint.sh/docs/model-checkers),
[TLC](https://docs.tlapl.us/using%3Atlc%3Astart),
[fast-check commands](https://fast-check.dev/docs/advanced/model-based-testing/),
[Gillian repository](https://github.com/GillianPlatform/Gillian),
[Verus](https://verus-lang.github.io/verus/guide/),
[Frama-C](https://www.frama-c.com/).

Quint's backend choice matters. TLC explores all reachable states of a finite
model without a fixed trace-length limit. A normal Apalache run checks a stated
step bound; Quint also supports a separate inductive-invariant check. Report
which method ran and the model's limits. Neither result automatically applies
to the implementation. Sources: [checker limits](https://quint.sh/docs/model-checkers),
[inductive checks](https://quint.sh/docs/checking-properties).

Quint can export traces for a custom Deno test driver. Its documented Quint
Connect library targets Rust; this assessment does not assume a ready-made Deno
integration. Trace replay is a test of model/code agreement, not a proof of it.
Source: [model-based testing](https://quint.sh/docs/model-based-testing).

### Recommended first scope

For a formal-methods trial, choose Quint/TLC plus a Deno trace runner. Choose
direct Lean instead if proving general theorems is the main aim. Use the same
narrow starting scope either way:

1. Model one connection, a small set of statements, and iterator ownership.
2. Cover prepare, run, next, return, dispose, close, and failure exits. Include
   invalid operations and their expected rejection, not just valid sequences.
3. Check that each allocation is finalized at most once, active iterator counts
   match their owners, closed handles cannot execute, and cleanup remains
   correct when callbacks or native operations fail.
4. Run corresponding sequences against the real library using the existing
   safe fault-injection approach. Record native calls without passing invalid
   pointers to SQLite. Require deliberately broken cleanup to fail a check.
5. Extend to nested transactions and backup cancellation only after that
   model and its implementation tests agree.

Keep proof tools and trace generation in development/CI. No runtime dependency
or production refactor is needed to begin this model-based approach.
