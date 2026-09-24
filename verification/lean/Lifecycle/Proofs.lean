import Lifecycle.Model

namespace Lifecycle

set_option maxHeartbeats 4000000

@[simp] theorem history_step (h : History xs true) : History (.step :: xs) true := .step h
@[simp] theorem history_reset (h : History xs true) : History (.reset :: xs) true := .reset h
@[simp] theorem history_finalize (h : History xs true) : History (.finalize :: xs) false := .finalize h

private theorem live_history_aux (h : History xs live) :
    live = true → NativeCall.finalize ∉ xs := by
  induction h with
  | initial => simp
  | step _ ih => simpa using ih
  | reset _ ih => simpa using ih
  | finalize => simp

/-- The actual native call log of a live allocation has no finalization. -/
theorem live_history (h : History xs true) : NativeCall.finalize ∉ xs :=
  live_history_aux h rfl

/-- A finalized allocation's log ends with precisely its sole finalization;
    every earlier call occurred while live. Lists are newest-first. -/
theorem dead_history (h : History xs false) :
    ∃ before, xs = .finalize :: before ∧ NativeCall.finalize ∉ before := by
  cases h with
  | finalize before => exact ⟨_, rfl, live_history before⟩

theorem allocation_finalize_at_most_once (h : History xs live) :
    xs.count .finalize ≤ 1 := by
  cases live with
  | true =>
    have hz : xs.count .finalize = 0 := List.count_eq_zero.mpr (live_history h)
    omega
  | false =>
    obtain ⟨before, rfl, hn⟩ := dead_history h
    have hz : before.count .finalize = 0 := List.count_eq_zero.mpr hn
    simp [hz]

/-- In chronological order no step/reset follows a finalize. This characterizes
    the entire retained history, so an invalid call cannot hide in a final state. -/
theorem no_use_after_finalize (h : History xs live) :
    ∀ newer older, xs = newer ++ .finalize :: older → newer = [] := by
  intro newer older heq
  cases live with
  | true => have hn := live_history h; simp_all
  | false =>
    obtain ⟨before, hb, hn⟩ := dead_history h
    cases newer with
    | nil => rfl
    | cons x rest =>
      rw [hb] at heq
      simp only [List.cons_append, List.cons.injEq] at heq
      have tail : before = rest ++ .finalize :: older := heq.2
      simp [tail] at hn

@[simp] theorem initial_invariant : Invariant ({} : State) := by
  simp [Invariant, activeOwners]

/-- Local proof for every operation/failure choice, before the public guards.
    The guards establish the hypotheses below rather than excluding bad API
    inputs from the overall transition theorem. -/
theorem perform_preserves (op : Op) (c : Cell) (hh : History c.calls true)
    (hl : c.live = true)
    (hb : c.busy = (op.kind == .next || op.kind == .ret)) :
    (perform op c).cell.WF ∧
    (perform op c).cell.active = c.active + (perform op c).delta := by
  rcases op with ⟨kind, statement, iterator, address, fault, write, reader⟩
  cases kind <;> cases fault <;> cases hwrite : c.write <;>
    simp_all [perform, performCore, failedStep, failure, annotate, callbackEvents,
      release, record, Cell.WF, Cell.active]
  all_goals first
    | exact History.reset (History.step (History.step (History.step (History.step hh))))
    | (split <;> simp_all [record, release, Cell.WF, Cell.active])

theorem onCell_preserves (s : State) (op : Op) (c : Cell) (hc : c.WF) :
    (onCell s op c).cell.WF ∧
    (onCell s op c).cell.active = c.active + (onCell s op c).delta := by
  unfold onCell
  split <;> try simp_all [unchanged]
  split <;> try simp_all [unchanged]
  split
  · split <;> try simp_all [unchanged]
    split <;> try simp_all [unchanged]
    split <;> try simp_all [unchanged]
    have hb : c.busy = true := by simp_all
    have hl : c.live = true := hc.2 hb
    apply perform_preserves op c (by simpa [hl] using hc.1) hl
    simp_all
  · split <;> try simp_all [unchanged]
    split <;> try simp_all [unchanged]
    split <;> try simp_all [unchanged]
    split <;> try simp_all [unchanged]
    split <;> try simp_all [unchanged]
    split <;> try simp_all [unchanged]
    have hl : c.live = true := by simp_all
    apply perform_preserves op c (by simpa [hl] using hc.1) hl
    simp_all

/-- Closed connections cannot create live allocations through cell operations. -/
theorem onCell_closed (s : State) (op : Op) (c : Cell)
    (hs : s.isOpen = false) (hl : c.live = false) (hc : c.WF) :
    (onCell s op c).cell.live = false := by
  have hb : c.busy = false := by
    cases h : c.busy <;> simp_all [Cell.WF]
  simp [onCell, hs, hl, hb, unchanged]
  all_goals repeat' first | split | simp_all [unchanged]

theorem updateAt_preserves (s : State) (op : Op) (n : Nat) (cs : List Cell)
    (hw : ∀ c ∈ cs, c.WF) :
    (∀ c ∈ (updateAt s op n cs).1, c.WF) ∧
    activeOwners (updateAt s op n cs).1 = activeOwners cs + (updateAt s op n cs).2.1 := by
  induction cs generalizing n with
  | nil => simp [updateAt, activeOwners]
  | cons c cs ih =>
    cases n with
    | zero =>
      have h := onCell_preserves s op c (hw c (by simp))
      simp only [updateAt]
      constructor
      · simpa using And.intro h.1 (fun a ha => hw a (by simp [ha]))
      · simp only [activeOwners, h.2]; omega
    | succ n =>
      have h := ih n (fun a ha => hw a (by simp [ha]))
      simp only [updateAt]
      constructor
      · simpa using And.intro (hw c (by simp)) h.1
      · simp only [activeOwners, h.2]; omega

theorem updateAt_closed (s : State) (op : Op) (n : Nat) (cs : List Cell)
    (hs : s.isOpen = false) (hw : ∀ c ∈ cs, c.WF)
    (hd : ∀ c ∈ cs, c.live = false) :
    ∀ c ∈ (updateAt s op n cs).1, c.live = false := by
  induction cs generalizing n with
  | nil => simp [updateAt]
  | cons c cs ih =>
    cases n with
    | zero =>
      have h := onCell_closed s op c hs (hd c (by simp)) (hw c (by simp))
      simpa [updateAt] using And.intro h (fun a ha => hd a (by simp [ha]))
    | succ n =>
      have h := ih n (fun a ha => hw a (by simp [ha])) (fun a ha => hd a (by simp [ha]))
      simpa [updateAt] using And.intro (hd c (by simp)) h

theorem active_nonnegative (c : Cell) : 0 ≤ c.active := by
  simp only [Cell.active]; split <;> omega

theorem owners_nonnegative (cs : List Cell) : 0 ≤ activeOwners cs := by
  induction cs with
  | nil => simp [activeOwners]
  | cons c cs ih => have h := active_nonnegative c; simp only [activeOwners]; omega

theorem owners_zero (cs : List Cell) (h : activeOwners cs = 0) :
    ∀ c ∈ cs, c.busy = false := by
  induction cs with
  | nil => simp
  | cons c cs ih =>
    have hc := active_nonnegative c
    have ht := owners_nonnegative cs
    simp only [activeOwners] at h
    have hz : activeOwners cs = 0 := by omega
    have hb : c.busy = false := by
      cases hb : c.busy with
      | false => rfl
      | true => simp [Cell.active, hb] at h; omega
    simpa using And.intro hb (ih hz)

theorem closeCell_preserves (c : Cell) (hc : c.WF) (hb : c.busy = false) :
    (closeCell c).WF ∧ (closeCell c).live = false ∧ (closeCell c).busy = false := by
  unfold closeCell
  split <;> simp_all [Cell.WF]

theorem activeOwners_append (xs ys : List Cell) :
    activeOwners (xs ++ ys) = activeOwners xs + activeOwners ys := by
  induction xs with
  | nil => simp [activeOwners]
  | cons c cs ih => simp only [List.cons_append, activeOwners, ih]; omega

@[simp] theorem activeOwners_close (cs : List Cell) (h : ∀ c ∈ cs, c.busy = false) :
    activeOwners (cs.map closeCell) = 0 := by
  induction cs with
  | nil => simp [activeOwners]
  | cons c cs ih =>
    have hb : c.busy = false := h c (by simp)
    have ht := ih (fun a ha => h a (by simp [ha]))
    simp [activeOwners, ht, closeCell, Cell.active, hb]
    split <;> simp_all

theorem append_preserves (s : State) (c : Cell) (h : Invariant s)
    (ho : s.isOpen = true) (hw : c.WF) (hb : c.busy = false) :
    Invariant { s with cells := s.cells ++ [c] } := by
  rcases h with ⟨hs, hc, hd, hg⟩
  refine ⟨?_, ?_, ?_, hg⟩
  · intro a ha
    simp only [List.mem_append, List.mem_singleton] at ha
    rcases ha with ha | rfl
    · exact hs a ha
    · exact hw
  · simpa [activeOwners_append, activeOwners, Cell.active, hb] using hc
  · simp [ho]

/-- No preconditions on the operation or selected native outcome. -/
theorem dispatch_preserves (s : State) (op : Op) (h : Invariant s) :
    Invariant (dispatch s op).state := by
  have original := h
  rcases h with ⟨hw, hc, hd, hg⟩
  unfold dispatch
  split
  · split
    · exact original
    · have ho : s.isOpen = true := by cases hs : s.isOpen <;> simp_all
      split
      · simp_all
      · split
        · exact original
        · split
          · apply append_preserves s _ original ho
            · simp [Cell.WF, History.initial]
            · rfl
          · apply append_preserves s _ original ho
            · simp [Cell.WF, History.initial]
            · rfl
  · split
    · split
      · exact original
      · split
        · exact original
        · have hz : activeOwners s.cells = 0 := by simp_all
          have hb := owners_zero s.cells hz
          have hh := fun c hm => closeCell_preserves c (hw c hm) (hb c hm)
          simp_all [Invariant]
    · have hu := updateAt_preserves s op op.statement s.cells hw
      have hh := updateAt_closed s op op.statement s.cells
      refine ⟨hu.1, ?_, fun hs => hh hs hw (hd hs), hg⟩
      change s.count + (updateAt s op op.statement s.cells).2.1 =
        activeOwners (updateAt s op op.statement s.cells).1
      omega

theorem onCell_reentry (s : State) (op : Op) (c : Cell) (hg : s.executing = true) :
    (onCell s op c).cell = c ∧ (onCell s op c).delta = 0 := by
  simp only [onCell, hg]
  repeat' first | split | simp_all [unchanged]

theorem updateAt_reentry (s : State) (op : Op) (n : Nat) (cs : List Cell)
    (hg : s.executing = true) :
    (updateAt s op n cs).1 = cs ∧ (updateAt s op n cs).2.1 = 0 := by
  induction cs generalizing n with
  | nil => simp [updateAt]
  | cons c cs ih =>
    cases n with
    | zero => simpa [updateAt] using onCell_reentry s op c hg
    | succ n => simpa [updateAt] using ih n

/-- Reentry may reject or finish already-completed cleanup. In every case it
    preserves every state field, including the held outer guard. -/
theorem reentry_preserves (s : State) (op : Op) (hg : s.executing = true) :
    (dispatch s op).state = s := by
  unfold dispatch
  split
  · split <;> simp_all [reject]
  · split
    · split <;> simp_all [reject]
    · have h := updateAt_reentry s op op.statement s.cells hg
      simp_all
      cases s <;> simp_all

theorem nested_preserves (s : State) (ops : List Op) (hg : s.executing = true) :
    nestedDispatch s ops = s := by
  induction ops generalizing s with
  | nil => rfl
  | cons op ops ih =>
    simp only [nestedDispatch, List.foldl_cons, reentry_preserves s op hg]
    exact ih s hg

theorem phase_preserves (s : State) (op : Op) (e : Event) (outcome : String)
    (hg : s.executing = false) : phase s op e outcome = s := by
  simp [phase, guarded, nested_preserves]
  all_goals cases s <;> simp_all

theorem phases_preserve (s : State) (op : Op) (es : List Event) (outcome : String)
    (hg : s.executing = false) : phases s op es outcome = s := by
  induction es generalizing s with
  | nil => rfl
  | cons e es ih =>
    simp only [phases, List.foldl_cons, phase_preserves s op e outcome hg]
    exact ih s hg

theorem dispatch_guard (s : State) (op : Op) :
    (dispatch s op).state.executing = s.executing := by
  unfold dispatch
  repeat' first | split | rfl

/-- Both callback phases use the same dispatcher: reset callbacks observe the
    released iterator owner, whereas step/verbose callbacks observe the owner
    held by the outer operation. Both preserve that phase's state. -/
theorem transition_eq_dispatch (s : State) (op : Op) (hg : s.executing = false) :
    (transition s op).state = (dispatch s op).state := by
  simp only [transition, phases_preserve s op _ _ hg]
  exact phases_preserve _ op _ _ (by rw [dispatch_guard, hg])

theorem transition_preserves (s : State) (op : Op) (h : Invariant s) :
    Invariant (transition s op).state := by
  rw [transition_eq_dispatch s op h.2.2.2]
  exact dispatch_preserves s op h

/-- Induction covers any finite number of operations, including rejects and
    failures at any modeled point. -/
theorem finite_preservation (ops : List Op) (s : State) (h : Invariant s) :
    Invariant (run ops s) := by
  induction ops generalizing s with
  | nil => exact h
  | cons op ops ih => exact ih _ (transition_preserves s op h)

theorem iterator_count_matches_owners (ops : List Op) :
    (run ops).count = activeOwners (run ops).cells ∧ 0 ≤ (run ops).count := by
  have h := finite_preservation ops {} initial_invariant
  constructor
  · exact h.2.1
  · rw [h.2.1]; exact owners_nonnegative _

theorem owners_are_handles (cs : List Cell) (start : Nat) :
    activeOwners cs = Int.ofNat (ownerHandles start cs).length := by
  induction cs generalizing start with
  | nil => simp [activeOwners, ownerHandles]
  | cons c cs ih =>
    simp only [activeOwners, ownerHandles, List.length_append]
    rw [ih (start+1)]
    cases hb : c.busy <;> simp [Cell.active, hb]

theorem iterator_count_is_handle_count (ops : List Op) :
    (run ops).count = Int.ofNat (ownerHandles 0 (run ops).cells).length := by
  rw [(iterator_count_matches_owners ops).1, owners_are_handles]

theorem reachable_allocation_safety (ops : List Op) (c : Cell) (hm : c ∈ (run ops).cells) :
    c.calls.count .finalize ≤ 1 ∧
    (∀ newer older, c.calls = newer ++ .finalize :: older → newer = []) := by
  have h := (finite_preservation ops {} initial_invariant).1 c hm
  exact ⟨allocation_finalize_at_most_once h.1, no_use_after_finalize h.1⟩

/-- The release operation records exactly one reset, closes its owner, advances
    the generation, and decrements the independently stored signed count. -/
theorem iterator_release_once (id : Nat) (c : Cell) (calls : List NativeCall) (outcome : String) :
    (release id c calls outcome).cell.busy = false ∧
    (release id c calls outcome).cell.completed = c.completed + 1 ∧
    (release id c calls outcome).delta = -1 := by
  simp [release, record]

theorem repeated_return_preserves (s : State) (c : Cell) (id gen : Nat)
    (hp : c.exposed = true) (hg : gen < c.completed) :
    onCell s { kind := .ret, statement := id, iterator := gen } c = unchanged c "done" := by
  simp [onCell, hp, hg]

/-- `finally` clears the guard for both normal and exceptional body results. -/
theorem guard_clears (s : State) (body : State → Except String α × State) :
    (guarded s body).2.executing = false := by simp [guarded]

/-- Any completed modeled API operation preserves a clear guard. -/
theorem operation_guard_clears (s : State) (op : Op) (h : Invariant s) :
    (transition s op).state.executing = false := (transition_preserves s op h).2.2.2

/-- A rejected connection close retains the exact ownership and native history,
    rather than merely leaving a valid but different owner configuration. -/
theorem busy_close_preserves (s : State) (hg : s.executing = false)
    (ho : s.isOpen = true) (hc : s.count ≠ 0) :
    (transition s { kind := .close }).state = s := by
  rw [transition_eq_dispatch s _ hg]
  simp [dispatch, ho, hc, hg, reject]

/-- Ordinary statement API operations reject an active iterator owner before
    making native calls or changing ownership. -/
theorem busy_statement_preserves (s : State) (c : Cell) (op : Op)
    (ho : s.isOpen = true) (hg : s.executing = false)
    (hp : c.exposed = true) (hl : c.live = true) (hb : c.busy = true)
    (hn : op.kind ≠ .next) (hr : op.kind ≠ .ret) :
    onCell s op c = unchanged c "error:busy" := by
  simp [onCell, ho, hg, hp, hl, hb, hn, hr]

theorem statement_cleanup_releases (s : State) (c : Cell) (id : Nat)
    (ho : s.isOpen = true) (hg : s.executing = false)
    (hp : c.exposed = true) (hl : c.live = true) (hb : c.busy = false) :
    (onCell s { kind := .dispose, statement := id } c).cell.live = false ∧
    (onCell s { kind := .dispose, statement := id } c).events = [event id c "finalize"] := by
  simp [onCell, perform, performCore, ho, hg, hp, hl, hb, record, nativeName, event]

theorem repeated_dispose_preserves (s : State) (c : Cell) (id : Nat)
    (hp : c.exposed = true) (hl : c.live = false) :
    onCell s { kind := .dispose, statement := id } c = unchanged c "disposed" := by
  simp [onCell, hp, hl]

/-- Cleanup must release all allocations when public close is allowed. -/
theorem cleanup_releases (s : State) (h : Invariant s) (ho : s.isOpen = true)
    (hz : s.count = 0) :
    (transition s { kind := .close }).state.isOpen = false ∧
    (∀ c ∈ (transition s { kind := .close }).state.cells, c.live = false) := by
  have hp := transition_preserves s { kind := .close } h
  have he : (transition s { kind := .close }).state.isOpen = false := by
    rw [transition_eq_dispatch s _ h.2.2.2]
    simp [dispatch, ho, hz, h.2.2.2]
  exact ⟨he, hp.2.2.1 he⟩

end Lifecycle
