use roundhouse_core::{
    dispatch, tool_decision, Call, Config, Environment, Monitor, Provider, ProviderKind, Session,
};
use serde_json::{json, Value};

fn monitor() -> Monitor {
    serde_json::from_value(json!({"id":"api","health_url":"https://app.test/health","interval_seconds":5,"timeout_seconds":1,"expected_status":200,"environment":"production","actions":[{"name":"restart","description":"Restart stopped worker","url":"https://app.test/recover"}]})).unwrap()
}

#[test]
fn named_actions_require_exact_authority_and_cannot_replay() {
    let mut m = monitor();
    let call = Call {
        id: "1".into(),
        name: "request_recovery".into(),
        arguments: json!({"action":"restart"}),
    };
    assert_eq!(tool_decision(&m, &call, None, false), "approval_required");
    assert_eq!(
        tool_decision(&m, &call, Some("different"), false),
        "approval_required"
    );
    assert_eq!(tool_decision(&m, &call, Some("restart"), false), "execute");
    assert_eq!(tool_decision(&m, &call, Some("restart"), true), "deny");
    m.actions[0].auto_approve = true;
    assert_eq!(tool_decision(&m, &call, None, false), "approval_required");
    m.environment = Environment::Test;
    assert_eq!(tool_decision(&m, &call, None, false), "execute");
    for (name, args) in [
        ("shell", json!({})),
        ("request_recovery", json!({"action":"delete"})),
        (
            "request_recovery",
            json!({"action":"restart","url":"https://evil.test"}),
        ),
        ("inspect_system", json!({"url":"https://evil.test"})),
    ] {
        assert_eq!(
            tool_decision(
                &m,
                &Call {
                    id: "2".into(),
                    name: name.into(),
                    arguments: args
                },
                Some("restart"),
                false
            ),
            "deny"
        );
    }
}

#[test]
fn configuration_rejects_production_auto_approval_and_unsafe_urls() {
    let base = json!({"provider":{"kind":"anthropic","base_url":"https://api.anthropic.com/v1","model":"test","max_output_tokens":512},"limits":{"daily_budget_microusd":100,"reserve_per_request_microusd":10,"daily_requests":10,"requests_per_incident":3,"daily_actions":1,"investigation_timeout_seconds":10},"monitors":[monitor()]});
    assert!(Config::parse(&base.to_string()).is_ok());
    for url in [
        "http://remote.test/health",
        "https://user:password@app.test/health",
        "https://app.test/health?key=credential",
        "https://app.test/health#fragment",
    ] {
        let mut c = base.clone();
        c["monitors"][0]["health_url"] = json!(url);
        assert!(Config::parse(&c.to_string()).is_err());
    }
    for model in ["bad model".to_owned(), "\t".to_owned(), "x".repeat(257)] {
        let mut c = base.clone();
        c["provider"]["model"] = json!(model);
        assert!(Config::parse(&c.to_string()).is_err());
    }
    let mut oversized = base.clone();
    oversized["monitors"][0]["actions"][0]["name"] = json!("x".repeat(65536));
    assert!(Config::parse(&oversized.to_string()).is_err());
    let mut boundary = base.clone();
    boundary["provider"]["model"] = json!("x".repeat(256));
    let parsed = Config::parse(&boundary.to_string()).unwrap();
    assert!(Session::new(Value::Null)
        .request(&parsed.provider, &parsed.monitors[0].actions)
        .is_ok());
    let mut c = base;
    c["monitors"][0]["actions"][0]["auto_approve"] = json!(true);
    assert!(Config::parse(&c.to_string()).is_err());
}

#[test]
fn both_provider_conversations_preserve_tool_ids_results_and_output_limits() {
    for kind in [ProviderKind::Anthropic, ProviderKind::OpenaiCompatible] {
        let mut session = Session::new(json!({"healthy":false}));
        let response = match kind {
            ProviderKind::Anthropic => {
                json!({"content":[{"type":"tool_use","id":"inspect-42","name":"inspect_system","input":{}}]})
            }
            ProviderKind::OpenaiCompatible => {
                json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"inspect-42","type":"function","function":{"name":"inspect_system","arguments":"{}"}}]}}]})
            }
        };
        let reply = session.accept(&kind, response).unwrap();
        assert_eq!(reply.calls[0].id, "inspect-42");
        session
            .results(vec![
                json!({"type":"tool_result","tool_use_id":"inspect-42","content":"worker stopped"}),
            ])
            .unwrap();
        let provider = Provider {
            kind,
            base_url: "https://model.test/v1".into(),
            model: "test".into(),
            max_output_tokens: 37,
        };
        let body = session.request(&provider, &monitor().actions).unwrap();
        assert_eq!(body["max_tokens"], 37);
        assert!(body.to_string().contains("inspect-42"));
        assert!(body.to_string().contains("worker stopped"));
        if matches!(provider.kind, ProviderKind::OpenaiCompatible) {
            assert_eq!(body["messages"][3]["role"], "tool");
            assert_eq!(body["stream"], false);
        }
    }
}

#[test]
fn invalid_provider_tool_json_and_duplicate_ids_fail_closed() {
    let mut s = Session::new(Value::Null);
    assert!(s.accept(&ProviderKind::OpenaiCompatible,json!({"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"1","type":"function","function":{"name":"request_recovery","arguments":"not-json"}}]}}]})).is_err());
    assert!(s.accept(&ProviderKind::Anthropic,json!({"content":[{"type":"tool_use","id":"same","name":"inspect_system","input":{}},{"type":"tool_use","id":"same","name":"inspect_system","input":{}}]})).is_err());
}

#[test]
fn anthropic_thinking_is_forwarded_unchanged_but_not_exposed_as_a_summary() {
    let mut session = Session::new(Value::Null);
    let blocks = json!([{"type":"thinking","thinking":"private model reasoning","signature":"opaque-signature"},{"type":"redacted_thinking","data":"opaque-data"},{"type":"text","text":"Worker stopped"},{"type":"tool_use","id":"inspect","name":"inspect_system","input":{}}]);
    let reply = session
        .accept(&ProviderKind::Anthropic, json!({"content":blocks}))
        .unwrap();
    assert_eq!(reply.text, "Worker stopped");
    assert_eq!(reply.calls.len(), 1);
    let p = Provider {
        kind: ProviderKind::Anthropic,
        base_url: "https://model.test".into(),
        model: "test".into(),
        max_output_tokens: 100,
    };
    session
        .results(vec![
            json!({"type":"tool_result","tool_use_id":"inspect","content":"stopped"}),
        ])
        .unwrap();
    assert_eq!(
        session.request(&p, &[]).unwrap()["messages"][1]["content"],
        blocks
    );
}

#[test]
fn telemetry_requires_explicit_supported_semantics_and_bounded_properties() {
    let base = json!({"id":"1","service":"api","name":"depth","timestamp":100,"kind":"metric","metric_type":"gauge","value":-7,"unit":"jobs","properties":{"zone":"west"}});
    let parse =
        |v: Value| dispatch(&json!({"op":"telemetry","json":json!([v]).to_string()}).to_string());
    assert!(parse(base.clone()).is_ok());
    for field in ["counter", "histogram"] {
        let mut v = base.clone();
        v["metric_type"] = json!(field);
        assert!(parse(v).is_err());
    }
    for properties in [
        json!({"api_key":"credential"}),
        json!({"nested":{}}),
        json!({"array":[]}),
    ] {
        let mut v = base.clone();
        v["properties"] = properties;
        assert!(parse(v).is_err());
    }
    let mut v = base;
    v["unknown"] = json!(true);
    assert!(parse(v).is_err());
    let span = json!({"id":"2","service":"api","name":"query","timestamp":100,"kind":"span","trace_id":"00000000000000000000000000000000","span_id":"bbbbbbbbbbbbbbbb","duration_ms":1,"status":"ok"});
    assert!(parse(span).is_err());
}
