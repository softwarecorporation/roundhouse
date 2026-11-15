use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Explicit capture only. No cookies, automatic identity collection, or session recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub id: String,
    pub service: String,
    pub name: String,
    pub timestamp: u64,
    #[serde(default)]
    pub properties: BTreeMap<String, Value>,
    #[serde(flatten)]
    pub data: SignalData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignalData {
    Event {
        distinct_id: String,
    },
    Log {
        level: Level,
        message: String,
        trace_id: Option<String>,
    },
    Span {
        trace_id: String,
        span_id: String,
        parent_span_id: Option<String>,
        duration_ms: f64,
        status: SpanStatus,
    },
    Metric {
        value: f64,
        unit: String,
        metric_type: MetricType,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricType {
    Gauge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpanStatus {
    Ok,
    Error,
    Unset,
}

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value.bytes().all(|c| c.is_ascii_hexdigit())
        && value.bytes().any(|c| c != b'0')
}

impl Signal {
    pub fn parse_batch(json: &str) -> Result<Vec<Self>, String> {
        // Flattened enums and deny_unknown_fields are incompatible in serde. Check
        // the full wire key set before deserializing so unknown fields fail closed.
        let items: Vec<Value> =
            serde_json::from_str(json).map_err(|_| "invalid telemetry batch")?;
        if items.is_empty() || items.len() > 100 {
            return Err("batch must contain 1 to 100 signals".into());
        }
        let mut result = Vec::new();
        for value in items {
            let obj = value.as_object().ok_or("invalid signal")?;
            let extra: &[&str] = match value["kind"].as_str() {
                Some("event") => &["distinct_id"],
                Some("log") => &["level", "message", "trace_id"],
                Some("span") => &[
                    "trace_id",
                    "span_id",
                    "parent_span_id",
                    "duration_ms",
                    "status",
                ],
                Some("metric") => &["value", "unit", "metric_type"],
                _ => return Err("unknown telemetry kind".into()),
            };
            if obj.keys().any(|k| {
                !["id", "service", "name", "timestamp", "properties", "kind"].contains(&k.as_str())
                    && !extra.contains(&k.as_str())
            }) {
                return Err("unknown telemetry field".into());
            }
            let s: Self = serde_json::from_value(value).map_err(|_| "invalid telemetry signal")?;
            s.validate()?;
            result.push(s);
        }
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if [&self.id, &self.service, &self.name]
            .iter()
            .any(|s| s.is_empty() || s.len() > 128)
            || self.timestamp > 8_640_000_000_000_000
            || self.properties.len() > 32
            || serde_json::to_string(&self.properties)
                .map_err(|_| "invalid properties")?
                .len()
                > 2048
        {
            return Err("invalid signal identity, time or properties".into());
        }
        for (key, value) in &self.properties {
            if key.is_empty()
                || key.len() > 64
                || crate::secrets::is_sensitive_env_var(key)
                || value.is_object()
                || value.is_array()
                || value.as_str().is_some_and(|s| s.len() > 512)
            {
                return Err("properties require bounded scalars without credential fields".into());
            }
        }
        match &self.data {
            SignalData::Event { distinct_id }
                if distinct_id.is_empty() || distinct_id.len() > 128 =>
            {
                return Err("invalid distinct id".into())
            }
            SignalData::Log {
                message, trace_id, ..
            } if message.len() > 4096 || trace_id.as_ref().is_some_and(|s| !hex(s, 32)) => {
                return Err("invalid log".into())
            }
            SignalData::Span {
                trace_id,
                span_id,
                parent_span_id,
                duration_ms,
                ..
            } if !hex(trace_id, 32)
                || !hex(span_id, 16)
                || parent_span_id.as_ref().is_some_and(|s| !hex(s, 16))
                || !duration_ms.is_finite()
                || *duration_ms < 0.0 =>
            {
                return Err("invalid span".into())
            }
            SignalData::Metric { value, unit, .. } if !value.is_finite() || unit.len() > 32 => {
                return Err("invalid metric".into())
            }
            _ => {}
        }
        Ok(())
    }
}
