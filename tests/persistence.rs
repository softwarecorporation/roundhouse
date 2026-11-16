use roundhouse::{config::Limits, store::Store};
use std::sync::Arc;

fn limits() -> Limits {
    Limits {
        daily_budget_microusd: 2000,
        reserve_per_request_microusd: 1000,
        daily_requests: 10,
        requests_per_incident: 8,
        daily_actions: 1,
        investigation_timeout_seconds: 5,
    }
}

#[test]
fn reservations_survive_reopen_and_apply_across_monitors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.sqlite");
    let store = Store::open(path.to_str().unwrap()).unwrap();
    let first = store.enqueue("first", Some("event-first")).unwrap();
    store.reserve_request(&first, &limits()).unwrap();
    drop(store);
    let store = Store::open(path.to_str().unwrap()).unwrap();
    let second = store.enqueue("second", Some("event-second")).unwrap();
    store.reserve_request(&second, &limits()).unwrap();
    assert!(store.reserve_request(&second, &limits()).is_err());
    assert!(store.reserve_request(&first, &limits()).is_err());
    assert_eq!(store.enqueue("first", Some("event-first")).unwrap(), first);
    assert!(store.enqueue("second", Some("event-first")).is_err());
}

#[test]
fn racing_action_requests_consume_one_durable_claim() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.sqlite");
    let store = Arc::new(Store::open(path.to_str().unwrap()).unwrap());
    let id = store.enqueue("application", None).unwrap();
    store.claim().unwrap().unwrap();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let store = store.clone();
            let id = id.clone();
            std::thread::spawn(move || store.claim_action(&id, "restart", true, 20).is_ok())
        })
        .collect();
    let successful = handles
        .into_iter()
        .filter_map(|h| h.join().ok())
        .filter(|ok| *ok)
        .count();
    assert_eq!(successful, 1);
    drop(store);
    let store = Store::open(path.to_str().unwrap()).unwrap();
    store.recover_interrupted().unwrap();
    assert_eq!(store.list().unwrap()[0].state, "needs_attention");
    assert!(store.claim_action(&id, "restart", true, 20).is_err());
    assert!(store.claim().unwrap().is_none());
}

#[test]
fn daily_action_limit_is_shared_by_distinct_incidents() {
    let store = Store::open(":memory:").unwrap();
    let first = store.enqueue("first", None).unwrap();
    let second = store.enqueue("second", None).unwrap();
    store.claim().unwrap().unwrap();
    store.claim_action(&first, "restart", true, 1).unwrap();
    store.claim().unwrap().unwrap();
    assert!(store.claim_action(&second, "restart", true, 1).is_err());
}

#[test]
fn changed_or_unknown_configuration_revokes_authority_without_resetting_limits() {
    for previous in [None, Some("before")] {
        let store = Store::open(":memory:").unwrap();
        if let Some(previous) = previous {
            store.bind_configuration(previous).unwrap();
        }
        let id = store.enqueue("first", Some("original-event")).unwrap();
        store.claim().unwrap().unwrap();
        let mut limits = limits();
        limits.daily_requests = 1;
        store.reserve_request(&id, &limits).unwrap();
        store.request_approval(&id, "restart").unwrap();
        store.finish(&id, "awaiting_approval").unwrap();
        assert!(store.approve(&id, "restart").unwrap());
        store.bind_configuration("after").unwrap();
        assert_eq!(store.list().unwrap()[0].state, "needs_attention");
        assert!(store.list().unwrap()[0].pending_action.is_none());
        assert!(!store.approve(&id, "restart").unwrap());
        assert!(store.claim().unwrap().is_none());
        assert!(store.claim_action(&id, "restart", false, 1).is_err());
        assert_eq!(store.enqueue("first", Some("original-event")).unwrap(), id);
        let next = store.enqueue("second", None).unwrap();
        assert!(store.reserve_request(&next, &limits).is_err());
    }
}
