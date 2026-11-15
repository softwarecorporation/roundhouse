use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub listen: String,
    pub database: String,
    pub api_token_env: String,
    pub event_token_env: String,
    pub provider: ProviderConfig,
    pub limits: Limits,
    pub monitors: Vec<Monitor>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
    pub api_key_env: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenaiCompatible,
    Anthropic,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub daily_budget_microusd: u64,
    pub reserve_per_request_microusd: u64,
    pub daily_requests: u32,
    pub requests_per_incident: u32,
    pub daily_actions: u32,
    pub investigation_timeout_seconds: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Monitor {
    pub id: String,
    pub health_url: String,
    pub expected_status: u16,
    pub interval_seconds: u64,
    pub timeout_seconds: u64,
    pub verification_attempts: u32,
    pub verification_interval_seconds: u64,
    pub environment: Environment,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    Test,
    Staging,
    Production,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub name: String,
    pub url: String,
    pub token_env: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub name: String,
    pub description: String,
    pub url: String,
    pub token_env: Option<String>,
    #[serde(default)]
    pub auto_approve: bool,
}

impl Config {
    pub fn load(path: &str) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|_| "cannot read configuration")?;
        let config: Self = serde_json::from_slice(&bytes).map_err(|e| {
            format!(
                "invalid configuration at line {} column {}",
                e.line(),
                e.column()
            )
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        self.listen
            .parse::<std::net::SocketAddr>()
            .map_err(|_| "invalid listen address")?;
        if secret(&self.api_token_env)? == secret(&self.event_token_env)? {
            return Err("operator and event tokens must be different".into());
        }
        secret(&self.provider.api_key_env)?;
        validate_url(&self.provider.base_url)?;
        if self.provider.model.is_empty() || self.monitors.is_empty() {
            return Err("model and at least one monitor are required".into());
        }
        let l = &self.limits;
        if l.reserve_per_request_microusd == 0
            || l.daily_budget_microusd < l.reserve_per_request_microusd
            || l.daily_budget_microusd > i64::MAX as u64
            || l.daily_requests == 0
            || l.requests_per_incident == 0
            || !(1..=600).contains(&l.investigation_timeout_seconds)
        {
            return Err("invalid spending or investigation limits".into());
        }
        let mut ids = HashSet::new();
        for m in &self.monitors {
            if m.id.is_empty()
                || !ids.insert(&m.id)
                || m.interval_seconds == 0
                || !(1..=60).contains(&m.timeout_seconds)
                || !(1..=10).contains(&m.verification_attempts)
                || !(1..=60).contains(&m.verification_interval_seconds)
                || !(100..=599).contains(&m.expected_status)
            {
                return Err("invalid or duplicate monitor".into());
            }
            validate_url(&m.health_url)?;
            let mut names = HashSet::new();
            for a in &m.actions {
                if a.name.is_empty() || !names.insert(&a.name) {
                    return Err("invalid or duplicate action".into());
                }
                if m.environment == Environment::Production && a.auto_approve {
                    return Err("production actions cannot be auto-approved".into());
                }
                validate_url(&a.url)?;
                if let Some(e) = &a.token_env {
                    secret(e)?;
                }
            }
            names.clear();
            for d in &m.diagnostics {
                if d.name.is_empty() || !names.insert(&d.name) {
                    return Err("invalid or duplicate diagnostic".into());
                }
                validate_url(&d.url)?;
                if let Some(e) = &d.token_env {
                    secret(e)?;
                }
            }
        }
        Ok(())
    }

    pub fn monitor(&self, id: &str) -> Option<&Monitor> {
        self.monitors.iter().find(|m| m.id == id)
    }
}

pub fn secret(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "a required secret environment variable is missing or empty".into())
}

fn validate_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid URL in configuration")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || !(url.scheme() == "https" || (local && url.scheme() == "http"))
    {
        return Err(
            "URLs require HTTPS (HTTP only on loopback), no userinfo/query/fragment".into(),
        );
    }
    Ok(())
}
