import Lifecycle

#print axioms Lifecycle.initial_invariant
#print axioms Lifecycle.transition_preserves
#print axioms Lifecycle.finite_preservation
#print axioms Lifecycle.allocation_finalize_at_most_once
#print axioms Lifecycle.no_use_after_finalize
#print axioms Lifecycle.reachable_allocation_safety
#print axioms Lifecycle.iterator_count_is_handle_count
#print axioms Lifecycle.iterator_count_matches_owners
#print axioms Lifecycle.iterator_release_once
#print axioms Lifecycle.repeated_return_preserves
#print axioms Lifecycle.guard_clears
#print axioms Lifecycle.operation_guard_clears
#print axioms Lifecycle.reentry_preserves
#print axioms Lifecycle.busy_close_preserves
#print axioms Lifecycle.busy_statement_preserves
#print axioms Lifecycle.statement_cleanup_releases
#print axioms Lifecycle.repeated_dispose_preserves
#print axioms Lifecycle.cleanup_releases
#print axioms Lifecycle.address_reuse_reachable
#print axioms Lifecycle.failed_row_releases_reachable
#print axioms Lifecycle.busy_rejection_reachable
#print axioms Lifecycle.partial_prepare_reachable
#print axioms Lifecycle.callback_reentry_success_reachable
#print axioms Lifecycle.callback_throw_reachable

#print axioms Lifecycle.reset_reentry_observes_released_owner
