import Std

namespace Lifecycle

/-- Allocation identity is the position in `State.cells`. An address is only an
    uninterpreted label: two different allocations may have the same address. -/
inductive NativeCall where
  | step | reset | finalize
  deriving BEq, ReflBEq, LawfulBEq, DecidableEq, Repr

/-- Newest call first. This records calls, including failed calls, not merely
    successful outcomes. There is deliberately no "check and discard" logger. -/
inductive History : List NativeCall → Bool → Prop where
  | initial : History [] true
  | step : History h true → History (.step :: h) true
  | reset : History h true → History (.reset :: h) true
  | finalize : History h true → History (.finalize :: h) false

structure Cell where
  address : Nat := 0
  exposed : Bool := true
  write : Bool := false
  reader : Bool := true
  live : Bool := true
  busy : Bool := false
  completed : Nat := 0
  remaining : Nat := 3
  calls : List NativeCall := []
  deriving Repr, BEq, DecidableEq

def Cell.active (c : Cell) : Int := if c.busy then 1 else 0

def Cell.WF (c : Cell) : Prop :=
  History c.calls c.live ∧ (c.busy = true → c.live = true)

structure State where
  isOpen : Bool := true
  executing : Bool := false
  count : Int := 0
  cells : List Cell := []
  deriving Repr, BEq, DecidableEq

def activeOwners : List Cell → Int
  | [] => 0
  | c :: cs => c.active + activeOwners cs

/-- A handle is (allocation identity, iterator generation). Closed generations
    remain distinguishable from the current owner; addresses are absent. -/
def ownerHandles : Nat → List Cell → List (Nat × Nat)
  | _, [] => []
  | allocation, c :: cs =>
    (if c.busy then [(allocation, c.completed)] else []) ++ ownerHandles (allocation+1) cs

def Invariant (s : State) : Prop :=
  (∀ c ∈ s.cells, c.WF) ∧ s.count = activeOwners s.cells ∧
  (s.isOpen = false → ∀ c ∈ s.cells, c.live = false) ∧ s.executing = false

inductive Kind where
  | prepare | get | all | run | iterate | next | ret | dispose | close
  deriving BEq, ReflBEq, LawfulBEq, DecidableEq, Repr

/-- SQLite calls may return errors. Reset errors are ignored except by run().
    Prepare errors may have no allocation or one owned partial allocation. -/
inductive Fault where
  | none | prepare | partialPrepare | step | row | reset
  | callback | verbose | callbackReenter | verboseReenter | finalize
  | resetCallback | stepResetCallback | resetReenter
  deriving BEq, ReflBEq, LawfulBEq, DecidableEq, Repr

structure Op where
  kind : Kind
  statement : Nat := 0
  iterator : Nat := 0
  address : Nat := 0
  fault : Fault := .none
  write : Bool := false
  reader : Bool := true
  deriving Repr, BEq, DecidableEq

structure Event where
  kind : String
  allocation : Option Nat := none
  address : Option Nat := none
  deriving Repr, BEq, DecidableEq

structure Answer where
  state : State
  outcome : String
  events : List Event := []
  deriving Repr, BEq, DecidableEq

/-- Per-allocation operation. `delta` is a real signed counter update; the proof
    checks it equals the change in owners, rather than defining the count as
    an owner count. Mutating -1 to 0 breaks the preservation proof. -/
structure Change where
  cell : Cell
  delta : Int := 0
  outcome : String
  events : List Event := []
  deriving Repr

def event (id : Nat) (c : Cell) (kind : String) : Event :=
  ⟨kind, some id, some c.address⟩

def nativeName : NativeCall → String
  | .step => "step" | .reset => "reset" | .finalize => "finalize"

/-- Append every intended native call to both the persistent history and the
    observable event stream. No validity test occurs in this function. -/
def record (id : Nat) (c : Cell) (calls : List NativeCall) (outcome : String)
    (delta : Int := 0) : Change :=
  ⟨{ c with calls := calls.reverse ++ c.calls }, delta, outcome,
    calls.map fun n => event id c (nativeName n)⟩

def unchanged (c : Cell) (outcome : String) : Change := ⟨c, 0, outcome, []⟩

def release (id : Nat) (c : Cell) (calls : List NativeCall) (outcome : String) : Change :=
  record id { c with busy := false, completed := c.completed + 1, remaining := 3 }
    (calls ++ [.reset]) outcome (-1)

/-- Native row callbacks run under the execution guard. The nested public call
    is modeled separately below (`reenter`) and leaves the guarded state intact. -/
def callbackEvents (id : Nat) (c : Cell) (fault : Fault) (events : List Event) : List Event :=
  if fault == .callbackReenter then
    events.flatMap fun e => if e.kind == "step" then [e, event id c "reenter"] else [e]
  else events

def annotate (id : Nat) (c : Cell) (fault : Fault) (ch : Change) : Change :=
  if fault == .verboseReenter then
    { ch with events := event id c "reenter" :: ch.events }
  else ch

def failedStep (f : Fault) : Bool := f == .step || f == .callback || f == .stepResetCallback

def failure (f : Fault) : String :=
  if f == .callback then "error:callback" else "error:native"

def performCore (op : Op) (c : Cell) : Change := Id.run do
  let id := op.statement
  let f := if c.write && (op.fault == .callback || op.fault == .callbackReenter) then
    Fault.none else op.fault
  if op.kind == .dispose then
    return record id { c with live := false } [.finalize] "disposed"
  if op.kind == .ret then
    return release id c [] (if f == .resetCallback || f == .stepResetCallback then "error:callback" else "done")
  if op.kind == .next then
    if f == .step || f == .stepResetCallback then return release id c [.step] "error:native"
    if c.remaining == 0 then
      return release id c [.step] (if f == .resetCallback then "error:callback" else "done")
    if f == .callback then return release id c [.step] "error:callback"
    if f == .row then return release id c [.step] "error:row"
    let ch := record id { c with remaining := c.remaining - 1 } [.step]
      ("row:" ++ toString (4 - c.remaining))
    return { ch with events := callbackEvents id c f ch.events }
  if f == .verbose then return record id c [.reset] "error:verbose"
  if op.kind == .iterate then
    return annotate id c f ⟨{ c with busy := true, remaining := 3 }, 1,
      "iterator:" ++ toString c.completed, []⟩
  if failedStep f then
    return annotate id c f (record id c [.step, .reset] (failure f))
  if f == .row && op.kind != .run then
    return annotate id c f (record id c [.step, .reset] "error:row")
  if op.kind == .all then
    let ch := record id c [.step, .step, .step, .step, .reset]
      (if f == .resetCallback then "error:callback" else "rows:1,2,3")
    let es := if f == .callbackReenter then
      [event id c "step", event id c "reenter", event id c "step", event id c "reenter",
       event id c "step", event id c "reenter", event id c "step", event id c "reset"]
      else ch.events
    return annotate id c f { ch with events := es }
  let outcome := if f == .resetCallback then "error:callback" else if op.kind == .run then
    (if f == .reset then "error:native" else if c.write then "run:3" else "run:0") else "row:1"
  let ch := record id c [.step, .reset] outcome
  return annotate id c f { ch with events := callbackEvents id c f ch.events }

/-- Reset callbacks run after iterator ownership has been released. Keep a
    distinct event marker so the full transition can use its post-cleanup state. -/
def perform (op : Op) (c : Cell) : Change :=
  let ch := performCore op c
  { ch with events :=
    if op.fault == .resetReenter && ch.events.any (fun e => e.kind == "reset") then
      ch.events ++ [event op.statement c "resetReenter"] else ch.events }

/-- Public validation, including invalid operations, is part of the transition.
    Repeated cleanup of a closed iterator/finalized statement is a no-op even
    after database close, matching the order of the TypeScript checks. -/
def onCell (s : State) (op : Op) (c : Cell) : Change :=
  if !c.exposed then unchanged c "error:missing"
  else if op.kind == .dispose && !c.live then unchanged c "disposed"
  else if op.kind == .next || op.kind == .ret then
    if op.iterator < c.completed then unchanged c "done"
    else if !c.busy || op.iterator != c.completed then unchanged c "error:missing"
    else if s.executing then unchanged c "error:busy"
    else perform op c
  else if !s.isOpen then unchanged c "error:closed"
  else if s.executing then unchanged c "error:busy"
  else if !c.live then unchanged c "error:finalized"
  else if c.busy then unchanged c "error:busy"
  else if !c.reader && (op.kind == .get || op.kind == .all || op.kind == .iterate) then unchanged c "error:reader"
  else if c.write && op.kind != .dispose && s.count != 0 then unchanged c "error:busy"
  else perform op c

/-- Replace one allocation by identity. Neither pointer values nor address
    labels take part in lookup. Missing IDs explicitly reject. -/
def updateAt (s : State) (op : Op) : Nat → List Cell → List Cell × Int × String × List Event
  | _, [] => ([], 0, "error:missing", [])
  | 0, c :: cs =>
    let ch := onCell s op c
    (ch.cell :: cs, ch.delta, ch.outcome, ch.events)
  | n + 1, c :: cs =>
    let r := updateAt s op n cs
    (c :: r.1, r.2.1, r.2.2.1, r.2.2.2)

def closeCell (c : Cell) : Cell :=
  if c.live then { c with live := false, calls := .finalize :: c.calls } else c

def closeEvents : Nat → List Cell → List Event
  | _, [] => []
  | n, c :: cs =>
    (if c.live then [event n c "finalize"] else []) ++ closeEvents (n+1) cs

def reject (s : State) (why : String) : Answer := ⟨s, why, []⟩

/-- Synchronous operation boundary. All native calls within an accepted
    operation use the guarded sub-operation below; the public result has the
    guard cleared on success and each exception path. -/
def dispatch (s : State) (op : Op) : Answer :=
  if op.kind == .prepare then
    if !s.isOpen then reject s "error:closed"
    else if s.executing then reject s "error:busy"
    else if op.fault == .prepare then
      ⟨s, "error:native", [⟨"prepare", none, none⟩]⟩
    else
      let id := s.cells.length
      let c : Cell := { address := op.address, write := op.write, reader := op.reader }
      if op.fault == .partialPrepare then
        let dead := { c with exposed := false, live := false, calls := [.finalize] }
        ⟨{ s with cells := s.cells ++ [dead] }, "error:native",
          [event id c "prepare", event id c "finalize"]⟩
      else
        ⟨{ s with cells := s.cells ++ [c] }, "prepared:" ++ toString id,
          [event id c "prepare"]⟩
  else if op.kind == .close then
    if !s.isOpen then reject s "closed"
    else if s.executing || s.count != 0 then reject s "error:busy"
    else ⟨{ s with isOpen := false, cells := s.cells.map closeCell }, "closed",
      closeEvents 0 s.cells ++ [⟨"close", none, none⟩]⟩
  else
    let r := updateAt s op op.statement s.cells
    ⟨{ s with cells := r.1, count := s.count + r.2.1 }, r.2.2.1, r.2.2.2⟩

/-- A guarded native call can return normally or throw. The `Except` value
    carries that distinction; the finally action clears the guard in both. -/
def guarded (s : State) (body : State → Except String α × State) : Except String α × State :=
  let (result, inner) := body { s with executing := true }
  (result, { inner with executing := false })

/-- Every callback probe calls the same dispatcher used by the outer API.
    Completed handles may return normally; active handles must reject. -/
def nestedOps (op : Op) : List Op :=
  [{kind := .prepare}, {kind := .close},
   { op with kind := .get, fault := .none },
   { op with kind := .dispose, fault := .none },
   { op with kind := .next, fault := .none },
   { op with kind := .ret, fault := .none }]

def nestedDispatch (s : State) (ops : List Op) : State :=
  ops.foldl (fun st op => (dispatch st op).state) s

/-- An accepted native phase sets the guard, exposes that state to reentrant
    public operations, and clears it on normal and exceptional exits. Returned
    nested state is used, never checked and discarded. -/
def phase (s : State) (op : Op) (e : Event) (outcome : String) : State :=
  (guarded s fun busy =>
    let inner := if e.kind == "reenter" then nestedDispatch busy (nestedOps op) else busy
    let result : Except String Unit :=
      if outcome.startsWith "error:" then .error outcome else .ok ()
    (result, inner)).2

def phases (s : State) (op : Op) (es : List Event) (outcome : String) : State :=
  es.foldl (fun st e => phase st op e outcome) s

def kindName : Kind → String
  | .prepare => "prepare" | .get => "get" | .all => "all" | .run => "run"
  | .iterate => "iterate" | .next => "next" | .ret => "return"
  | .dispose => "dispose" | .close => "close"

/-- Serialize actual nested-dispatch results and held guard snapshots. These
    observations, not a hard-coded expected rejection, drive the Deno oracle. -/
def nestedObservations (outer : Event) : State → List Op → List Event
  | _, [] => []
  | s, op :: ops =>
    let a := dispatch s op
    let e := { outer with kind := "reenter:" ++ kindName op.kind ++ ":" ++ a.outcome ++
      (if a.state.executing then ":guarded" else ":unguarded") }
    e :: nestedObservations outer a.state ops

def observedPhases (s : State) (op : Op) (es : List Event) (outcome : String) : List Event :=
  match es with
  | [] => []
  | e :: es =>
    let here := if e.kind == "reenter" then
      nestedObservations e { s with executing := true } (nestedOps op) else [e]
    here ++ observedPhases (phase s op e outcome) op es outcome

/-- Partition callback markers by their source phase. Native lifecycle events
    are never removed: only reset reentry markers move to the post-cleanup pass.
    `perform` emits a reset marker only at the end of a resetting operation. -/
def beforeCleanup (es : List Event) : List Event :=
  es.filter (fun e => e.kind != "resetReenter")

def afterCleanup (es : List Event) : List Event :=
  es.filterMap fun e => if e.kind == "resetReenter" then some { e with kind := "reenter" } else none

/-- Atomic synchronous API transition with explicit guarded callback phases.
    The native/event plan determines when callbacks can occur. Those callbacks
    run through dispatch, and their returned state feeds the outer operation.
    The proof establishes that valid reentry leaves it unchanged. -/
def transition (s : State) (op : Op) : Answer :=
  let plan := dispatch s op
  let before := beforeCleanup plan.events
  let a := dispatch (phases s op before plan.outcome) op
  let after := afterCleanup a.events
  { a with
    state := phases a.state op after a.outcome
    events := observedPhases s op before plan.outcome ++ observedPhases a.state op after a.outcome }

/-- A callback entering the public API observes an already-held guard. -/
def reenter (s : State) (op : Op) : Answer := dispatch { s with executing := true } op

def run (ops : List Op) (s : State := {}) : State :=
  ops.foldl (fun s op => (transition s op).state) s

end Lifecycle
