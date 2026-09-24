import Lifecycle.Proofs

namespace Lifecycle

/-- Same address, two allocation identities, independent retained histories. -/
def reuseExample : List Op := [
  { kind := .prepare, address := 17 }, { kind := .dispose, statement := 0 },
  { kind := .prepare, address := 17 }, { kind := .get, statement := 1 },
  { kind := .dispose, statement := 0 }, { kind := .close }]

theorem address_reuse_reachable :
    (run reuseExample).cells.length = 2 ∧ (run reuseExample).isOpen = false := by decide

def ownerExample : List Op := [
  { kind := .prepare, address := 8 }, { kind := .iterate, statement := 0 },
  { kind := .next, statement := 0, iterator := 0 },
  { kind := .close },
  { kind := .next, statement := 0, iterator := 0, fault := .row },
  { kind := .ret, statement := 0, iterator := 0 }, { kind := .close }]

theorem failed_row_releases_reachable :
    (run ownerExample).count = 0 ∧ (run ownerExample).isOpen = false := by decide

theorem busy_rejection_reachable :
    (transition (run (ownerExample.take 2)) {kind := .close}).outcome = "error:busy" := by decide

theorem partial_prepare_reachable :
    (run [{kind := .prepare, address := 2, fault := .partialPrepare}]).cells =
      [{address := 2, exposed := false, live := false, calls := [.finalize]}] := by decide

theorem callback_reentry_success_reachable :
    (transition (run [{kind := .prepare, address := 2}])
      {kind := .get, fault := .callbackReenter}).outcome = "row:1" := by decide

theorem callback_throw_reachable :
    (transition (run [{kind := .prepare, address := 2}])
      {kind := .get, fault := .callback}).outcome = "error:callback" := by decide

theorem reset_reentry_observes_released_owner :
    let a := transition (run [{kind := .prepare}, {kind := .iterate}])
      {kind := .ret, fault := .resetReenter}
    "reenter:next:done:guarded" ∈ a.events.map Event.kind ∧ a.state.count = 0 := by decide

end Lifecycle
