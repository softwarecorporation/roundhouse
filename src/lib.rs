#![forbid(unsafe_code)]
pub mod config;
pub mod engine;
pub mod store;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use engine::Runtime;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;

type ApiResult = Result<Json<Value>, StatusCode>;

pub fn router(rt: Arc<Runtime>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/v1/incidents", get(incidents))
        .route("/v1/incidents/{id}", get(history))
        .route("/v1/incidents/{id}/approve", post(approve))
        .route("/v1/events", post(event))
        .layer(axum::extract::DefaultBodyLimit::max(4096))
        .with_state(rt)
}

fn authorize(rt: &Runtime, headers: &HeaderMap) -> Result<(), StatusCode> {
    authorize_env(&rt.config.api_token_env, headers)
}

fn authorize_env(env: &str, headers: &HeaderMap) -> Result<(), StatusCode> {
    let expected = config::secret(env).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if bool::from(token.as_bytes().ct_eq(expected.as_bytes())) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn incidents(State(rt): State<Arc<Runtime>>, headers: HeaderMap) -> ApiResult {
    authorize(&rt, &headers)?;
    let items = rt
        .store
        .list()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(json!({"incidents":items})))
}

async fn history(
    State(rt): State<Arc<Runtime>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    authorize(&rt, &headers)?;
    let history = rt
        .store
        .history(&id)
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    if history.is_empty() {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Json(json!({"incident_id":id,"history":history})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Intake {
    monitor: String,
}

async fn event(
    State(rt): State<Arc<Runtime>>,
    headers: HeaderMap,
    Json(body): Json<Intake>,
) -> ApiResult {
    authorize_env(&rt.config.event_token_env, &headers)?;
    if rt.config.monitor(&body.monitor).is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or(StatusCode::BAD_REQUEST)?;
    let id = rt
        .store
        .enqueue(&body.monitor, Some(key))
        .map_err(|_| StatusCode::CONFLICT)?;
    Ok(Json(json!({"incident_id":id})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    action: String,
}

async fn approve(
    State(rt): State<Arc<Runtime>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Approval>,
) -> ApiResult {
    authorize(&rt, &headers)?;
    if !rt
        .store
        .approve(&id, &body.action)
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
    {
        return Err(StatusCode::CONFLICT);
    }
    Ok(Json(
        json!({"incident_id":id,"approved_action":body.action}),
    ))
}

pub async fn scheduler(rt: Arc<Runtime>) -> Result<(), String> {
    let mut deadlines = vec![tokio::time::Instant::now(); rt.config.monitors.len()];
    loop {
        for (m, deadline) in rt.config.monitors.iter().zip(&mut deadlines) {
            if tokio::time::Instant::now() >= *deadline {
                let evidence = rt.health(m).await;
                if evidence["healthy"] != true {
                    rt.store
                        .enqueue(&m.id, None)
                        .map_err(|_| "scheduler persistence failed")?;
                } else {
                    rt.store
                        .resolve_observed_healthy(&m.id, evidence)
                        .map_err(|_| "scheduler persistence failed")?;
                }
                *deadline = tokio::time::Instant::now() + Duration::from_secs(m.interval_seconds);
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub async fn worker(rt: Arc<Runtime>) -> Result<(), String> {
    loop {
        if let Some(incident) = rt.store.claim().map_err(|_| "worker persistence failed")? {
            let id = incident.id.clone();
            if rt.investigate(incident).await.is_err() {
                rt.store
                    .finish(&id, "needs_attention")
                    .map_err(|_| "worker persistence failed")?;
            }
        } else {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}
