use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub adapter: String,
    pub effect: ToolEffect,
    #[serde(default = "empty_options")]
    pub options: Value,
}

fn empty_options() -> Value {
    json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffect {
    Read,
    Sandbox,
    Privileged,
}

pub(crate) fn validate_registry(tools: &[RegisteredTool]) -> Result<(), String> {
    if tools.len() > 32 {
        return Err("too many registered tools".into());
    }
    let mut names = HashSet::new();
    for tool in tools {
        if tool.name.is_empty()
            || tool.name.len() > 64
            || !tool
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || matches!(tool.name.as_str(), "inspect_system" | "request_recovery")
            || !names.insert(&tool.name)
            || tool.adapter.trim().is_empty()
            || tool.input_schema["type"] != "object"
        {
            return Err("invalid registered tool".into());
        }
        schema(&tool.input_schema, 0)?;
    }
    Ok(())
}

// Only this closed subset is interpreted. Unknown or inapplicable keywords fail
// configuration rather than being advertised with unenforced semantics.
fn schema(s: &Value, depth: usize) -> Result<(), String> {
    let fail = || "unsupported or invalid tool schema".to_owned();
    if depth > 6 {
        return Err("tool schema exceeds recursion limit".into());
    }
    let obj = s.as_object().ok_or_else(fail)?;
    let kind = s["type"].as_str().ok_or_else(fail)?;
    let keywords: &[&str] = match kind {
        "object" => &["properties", "required", "additionalProperties"],
        "array" => &["items", "maxItems"],
        "string" => &["maxLength"],
        "integer" | "number" => &["minimum", "maximum"],
        "boolean" | "null" => &[],
        _ => return Err(fail()),
    };
    for key in obj.keys() {
        if key != "type" && key != "enum" && !keywords.contains(&key.as_str()) {
            return Err(fail());
        }
    }
    match kind {
        "object" => {
            if s["additionalProperties"] != false {
                return Err("tool object schemas must be closed".into());
            }
            let props = s["properties"].as_object().ok_or_else(fail)?;
            for child in props.values() {
                schema(child, depth + 1)?;
            }
            if let Some(required) = obj.get("required") {
                let mut seen = HashSet::new();
                for key in required.as_array().ok_or_else(fail)? {
                    let key = key.as_str().ok_or_else(fail)?;
                    if !props.contains_key(key) || !seen.insert(key) {
                        return Err(fail());
                    }
                }
            }
        }
        "array" => schema(obj.get("items").ok_or_else(fail)?, depth + 1)?,
        _ => {}
    }
    for key in ["maxLength", "maxItems"] {
        if let Some(limit) = obj.get(key) {
            if limit.as_u64().is_none() {
                return Err(fail());
            }
        }
    }
    for key in ["minimum", "maximum"] {
        if let Some(limit) = obj.get(key) {
            if !limit.is_number() {
                return Err(fail());
            }
        }
    }
    if compare_numbers(&s["minimum"], &s["maximum"]) == Some(Ordering::Greater) {
        return Err(fail());
    }
    if let Some(choices) = obj.get("enum") {
        let choices = choices.as_array().ok_or_else(fail)?;
        if choices.is_empty() {
            return Err(fail());
        }
        let mut without_enum = s.clone();
        without_enum.as_object_mut().unwrap().remove("enum");
        for (index, choice) in choices.iter().enumerate() {
            arguments(&without_enum, choice)?;
            if choices[..index].iter().any(|prior| equal(prior, choice)) {
                return Err(fail());
            }
        }
    }
    Ok(())
}

pub(crate) fn arguments(s: &Value, value: &Value) -> Result<(), String> {
    let fail = || "invalid tool arguments".to_owned();
    let valid = match s["type"].as_str() {
        Some("object") => {
            let obj = value.as_object().ok_or_else(fail)?;
            let props = s["properties"].as_object().ok_or_else(fail)?;
            if let Some(required) = s["required"].as_array() {
                for key in required {
                    if !obj.contains_key(key.as_str().ok_or_else(fail)?) {
                        return Err(fail());
                    }
                }
            }
            for (key, child) in obj {
                arguments(props.get(key).ok_or_else(fail)?, child)?;
            }
            true
        }
        Some("array") => {
            let items = value.as_array().ok_or_else(fail)?;
            if s["maxItems"]
                .as_u64()
                .is_some_and(|n| items.len() as u64 > n)
            {
                return Err(fail());
            }
            for item in items {
                arguments(&s["items"], item)?;
            }
            true
        }
        Some("string") => value.as_str().is_some_and(|text| {
            s["maxLength"]
                .as_u64()
                .is_none_or(|n| text.chars().count() as u64 <= n)
        }),
        Some("integer") => value.as_number().is_some_and(|n| {
            n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|v| v.fract() == 0.0)
        }),
        Some("number") => value.is_number(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        _ => false,
    };
    if !valid {
        return Err(fail());
    }
    if compare_numbers(value, &s["minimum"]) == Some(Ordering::Less)
        || compare_numbers(value, &s["maximum"]) == Some(Ordering::Greater)
    {
        return Err(fail());
    }
    if let Some(choices) = s["enum"].as_array() {
        if !choices.iter().any(|choice| equal(choice, value)) {
            return Err(fail());
        }
    }
    Ok(())
}

fn compare_numbers(a: &Value, b: &Value) -> Option<Ordering> {
    let integer = |v: &Value| {
        v.as_i64()
            .map(i128::from)
            .or_else(|| v.as_u64().map(i128::from))
    };
    match (integer(a), integer(b)) {
        (Some(a), Some(b)) => Some(a.cmp(&b)),
        (Some(a), None) => compare_integer_float(a, b.as_f64()?),
        (None, Some(b)) => compare_integer_float(b, a.as_f64()?).map(Ordering::reverse),
        (None, None) => a.as_f64()?.partial_cmp(&b.as_f64()?),
    }
}

fn compare_integer_float(integer: i128, float: f64) -> Option<Ordering> {
    if float < i128::MIN as f64 || float >= i128::MAX as f64 {
        return (integer as f64).partial_cmp(&float);
    }
    match integer.cmp(&(float as i128)) {
        Ordering::Equal => 0.0_f64.partial_cmp(&float.fract()),
        ordering => Some(ordering),
    }
}

fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => compare_numbers(a, b) == Some(Ordering::Equal),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equal(a, b)))
        }
        _ => a == b,
    }
}
