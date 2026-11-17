use roundhouse_core::{
    dispatch, tool_decision, validate_tool, Call, Config, Environment, Monitor, Provider,
    ProviderKind, RegisteredTool, Session,
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
        .request(&parsed.provider, &parsed.monitors[0].actions, &[])
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
        let body = session.request(&provider, &monitor().actions, &[]).unwrap();
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
        session.request(&p, &[], &[]).unwrap()["messages"][1]["content"],
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

fn registered_tool() -> RegisteredTool {
    serde_json::from_value(json!({
        "name":"lookup_queue_depth", "description":"Read queue depth", "adapter":"host.metrics", "effect":"read",
        "input_schema":{"type":"object", "properties":{"queue":{"type":"string","enum":["jobs","mail"],"maxLength":4}},"required":["queue"],"additionalProperties":false}
    })).unwrap()
}

fn config_with_tools(tools: Value) -> Value {
    let mut m = json!(monitor());
    m["tools"] = tools;
    json!({"provider":{"kind":"anthropic","base_url":"https://api.anthropic.com/v1","model":"test","max_output_tokens":512},"limits":{"daily_budget_microusd":100,"reserve_per_request_microusd":10,"daily_requests":10,"requests_per_incident":3,"daily_actions":1,"investigation_timeout_seconds":10},"monitors":[m]})
}

#[test]
fn registry_is_advertised_in_both_providers_without_host_metadata() {
    let tool = registered_tool();
    assert_eq!(tool.options, json!({}));
    for kind in [ProviderKind::Anthropic, ProviderKind::OpenaiCompatible] {
        let mut config = config_with_tools(json!([tool]));
        config["provider"]["kind"] = json!(kind);
        let c = Config::parse(&config.to_string()).unwrap();
        let m = &c.monitors[0];
        let body = Session::new(Value::Null)
            .request(&c.provider, &m.actions, &m.tools)
            .unwrap();
        assert_eq!(body["tools"].as_array().unwrap().len(), 3);
        let advertised = if kind == ProviderKind::Anthropic {
            &body["tools"][2]
        } else {
            &body["tools"][2]["function"]
        };
        assert_eq!(advertised["name"], tool.name);
        assert_eq!(advertised["description"], tool.description);
        let key = if kind == ProviderKind::Anthropic {
            "input_schema"
        } else {
            "parameters"
        };
        assert_eq!(advertised[key], tool.input_schema);
        assert!(!body.to_string().contains("host.metrics"));
        let call = Call {
            id: "custom".into(),
            name: tool.name.clone(),
            arguments: json!({"queue":"jobs"}),
        };
        assert_eq!(tool_decision(m, &call, None, true), "registered");
        let mut unknown = call.clone();
        unknown.name = "unconfigured_tool".into();
        assert_eq!(tool_decision(m, &unknown, None, false), "deny");
        assert_eq!(
            dispatch(&json!({"op":"validate_tool","tool":tool,"args":call.arguments}).to_string())
                .unwrap(),
            true
        );
    }
    let mut legacy = config_with_tools(json!([]));
    legacy["monitors"][0]
        .as_object_mut()
        .unwrap()
        .remove("tools");
    let materialized =
        dispatch(&json!({"op":"config","json":legacy.to_string()}).to_string()).unwrap();
    assert_eq!(materialized["monitors"][0]["tools"], json!([]));
    let c = Config::parse(&legacy.to_string()).unwrap();
    assert!(dispatch(&json!({"op":"request","session":Session::new(Value::Null),"provider":c.provider,"actions":[]}).to_string()).is_ok());
}

#[test]
fn registry_rejects_duplicate_reserved_unsafe_and_excess_tools() {
    let tool = registered_tool();
    assert!(Config::parse(&config_with_tools(json!([tool, tool])).to_string()).is_err());
    for name in [
        "",
        "inspect_system",
        "request_recovery",
        "bad name",
        "bad.name",
        "💥",
    ] {
        let mut t = tool.clone();
        t.name = name.into();
        assert!(
            Config::parse(&config_with_tools(json!([t])).to_string()).is_err(),
            "{name}"
        );
    }
    let mut t = tool.clone();
    t.name = "a".repeat(64);
    assert!(validate_tool(&t, &json!({"queue":"jobs"})).is_ok());
    t.name.push('a');
    assert!(validate_tool(&t, &json!({"queue":"jobs"})).is_err());
    let tools: Vec<_> = (0..33)
        .map(|i| {
            let mut t = tool.clone();
            t.name = format!("tool_{i}");
            t
        })
        .collect();
    assert!(Config::parse(&config_with_tools(json!(&tools[..32])).to_string()).is_ok());
    assert!(Config::parse(&config_with_tools(json!(tools)).to_string()).is_err());
    for (field, value) in [("effect", json!("execute")), ("unknown", json!(true))] {
        let mut t = json!(tool);
        t[field] = value;
        assert!(Config::parse(&config_with_tools(json!([t])).to_string()).is_err());
    }
}

#[test]
fn schemas_fail_closed_at_configuration_time() {
    let base = registered_tool();
    for invalid in [
        json!({"type":"object","properties":{}}),
        json!({"type":"object","properties":{},"additionalProperties":true}),
        json!({"type":"object","properties":{},"additionalProperties":false,"$ref":"#"}),
        json!({"type":"object","properties":{},"additionalProperties":false,"required":["missing"]}),
        json!({"type":"array","items":{"type":"string"}}),
    ] {
        let mut tool = base.clone();
        tool.input_schema = invalid;
        assert!(Config::parse(&config_with_tools(json!([tool])).to_string()).is_err());
    }
    for invalid in [
        json!({"type":"string","pattern":".*"}),
        json!({"type":["string","null"]}),
        json!({"type":"string","maxLength":-1}),
        json!({"type":"integer","minimum":2,"maximum":1}),
        json!({"type":"boolean","maximum":1}),
        json!({"type":"string","enum":[1]}),
        json!({"type":"string","enum":[]}),
        json!({"type":"array"}),
        json!({"type":"object","properties":{}}),
    ] {
        let mut tool = base.clone();
        tool.input_schema["properties"]["queue"] = invalid;
        assert!(Config::parse(&config_with_tools(json!([tool])).to_string()).is_err());
    }
    let mut nested = json!({"type":"string"});
    for depth in 1..=7 {
        nested =
            json!({"type":"object","properties":{"child":nested},"additionalProperties":false});
        let mut tool = base.clone();
        tool.input_schema = nested.clone();
        assert_eq!(
            Config::parse(&config_with_tools(json!([tool])).to_string()).is_ok(),
            depth <= 6
        );
    }
}

#[test]
fn exact_arguments_enforce_nested_types_fields_enums_and_limits() {
    let mut tool = registered_tool();
    tool.input_schema = json!({"type":"object","additionalProperties":false,"properties":{
        "text":{"type":"string","maxLength":2},
        "count":{"type":"integer","minimum":-1,"maximum":2},
        "ratio":{"type":"number","minimum":0.5,"maximum":1.5},
        "flag":{"type":"boolean"}, "nothing":{"type":"null"},
        "items":{"type":"array","maxItems":1,"items":{"type":"object","properties":{"mode":{"type":"string","enum":["ok"]}},"required":["mode"],"additionalProperties":false}}
    },"required":["text","count","ratio","flag","nothing","items"]});
    let args = json!({"text":"é😀","count":2,"ratio":1.25,"flag":false,"nothing":null,"items":[{"mode":"ok"}]});
    assert!(validate_tool(&tool, &args).is_ok());
    for (key, bad) in [
        ("text", json!("abc")),
        ("text", json!(2)),
        ("count", json!(-2)),
        ("count", json!(3)),
        ("count", json!(1.5)),
        ("ratio", json!(0.4)),
        ("ratio", json!(1.6)),
        ("ratio", json!("1")),
        ("flag", json!(0)),
        ("nothing", json!(false)),
        ("items", json!([{"mode":"ok"},{"mode":"ok"}])),
        ("items", json!([{"mode":"wrong"}])),
        ("items", json!([{"mode":"ok","extra":true}])),
        ("items", json!([{}])),
        ("extra", json!(true)),
    ] {
        let mut invalid = args.clone();
        invalid[key] = bad;
        assert!(validate_tool(&tool, &invalid).is_err(), "{invalid}");
        assert!(
            dispatch(&json!({"op":"validate_tool","tool":tool,"args":invalid}).to_string())
                .is_err()
        );
    }
    for key in args.as_object().unwrap().keys() {
        let mut missing = args.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(validate_tool(&tool, &missing).is_err());
    }
    assert!(validate_tool(&tool, &json!([])).is_err());
}

#[test]
fn rotary_preflight_bounds_combined_registry_and_real_conversation() {
    let tool = registered_tool();
    for field in ["description", "options", "input_schema"] {
        let mut t = json!(tool);
        if field == "input_schema" {
            t["input_schema"]["properties"]["queue"]["enum"] = json!(["x".repeat(65536)]);
            t["input_schema"]["properties"]["queue"]
                .as_object_mut()
                .unwrap()
                .remove("maxLength");
        } else {
            t[field] = json!("x".repeat(65536));
        }
        assert!(
            Config::parse(&config_with_tools(json!([t])).to_string()).is_err(),
            "{field}"
        );
    }
    let mut a = tool.clone();
    a.description = "d".repeat(33000);
    let mut b = tool.clone();
    b.name = "another".into();
    b.options = json!({"payload":"o".repeat(33000)});
    assert!(Config::parse(&config_with_tools(json!([a])).to_string()).is_ok());
    assert!(Config::parse(&config_with_tools(json!([b])).to_string()).is_ok());
    assert!(Config::parse(&config_with_tools(json!([a, b])).to_string()).is_err());
    let c = Config::parse(&config_with_tools(json!([tool])).to_string()).unwrap();
    let m = &c.monitors[0];
    assert!(Session::new(json!("x".repeat(65536)))
        .request(&c.provider, &m.actions, &m.tools)
        .is_err());
    for kind in [ProviderKind::Anthropic, ProviderKind::OpenaiCompatible] {
        let mut provider = c.provider.clone();
        provider.kind = kind;
        let empty = Session::new(json!(""))
            .request(&provider, &m.actions, &m.tools)
            .unwrap();
        let room = 65_536 - serde_json::to_vec(&empty).unwrap().len();
        let at_limit = Session::new(json!("x".repeat(room)))
            .request(&provider, &m.actions, &m.tools)
            .unwrap();
        assert_eq!(serde_json::to_vec(&at_limit).unwrap().len(), 65_536);
        assert!(Session::new(json!("x".repeat(room + 1)))
            .request(&provider, &m.actions, &m.tools)
            .is_err());
    }
}

#[test]
fn numeric_constraints_preserve_integer_precision_and_enum_value_equality() {
    let mut tool = registered_tool();
    tool.input_schema["properties"]["queue"] =
        json!({"type":"integer","minimum":9007199254740993_u64});
    assert!(validate_tool(&tool, &json!({"queue":9007199254740992_u64})).is_err());
    assert!(validate_tool(&tool, &json!({"queue":9007199254740992.0_f64})).is_err());
    assert!(validate_tool(&tool, &json!({"queue":9007199254740993_u64})).is_ok());
    tool.input_schema["properties"]["queue"] =
        json!({"type":"number","maximum":18446744073709551614_u64});
    assert!(validate_tool(&tool, &json!({"queue":u64::MAX})).is_err());
    tool.input_schema["properties"]["queue"] = json!({"type":"integer","enum":[1]});
    assert!(validate_tool(&tool, &json!({"queue":1.0})).is_ok());
    assert!(validate_tool(&tool, &json!({"queue":2})).is_err());
    tool.input_schema["properties"]["queue"] = json!({"type":"number","enum":[1,1.0]});
    assert!(Config::parse(&config_with_tools(json!([tool])).to_string()).is_err());
}
