//! The HTTP surface.
//!
//! Stage 0 mounts the two endpoints that need no state — `/healthz` and `/version` — plus the
//! router scaffolding the later stages hang their routes from. The route table is grouped by the
//! three audiences in `docs/contracts/m0.md` §6, because that grouping is what decides who may
//! reach a path: the gateway proxies `/t`, `/.well-known` and `/v1`, and **never** `/internal`.

use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

/// The OpenAPI document, derived from the handlers below so it cannot drift from them.
///
/// Only the stage-0 routes appear in it. The M0 feature work adds each new handler to the
/// `paths(...)` list in the same change that adds it to the router — the drift check in
/// `rust.yml` compares the generated `spec/openapi.json` against the committed copy, so a handler
/// that is routed but not documented fails on `main`.
#[derive(utoipa::OpenApi)]
#[openapi(
    info(
        title = "Monaca",
        version = env!("CARGO_PKG_VERSION"),
        description = "Identity and access management for the AI-agent era."
    ),
    paths(healthz, version)
)]
pub struct ApiDoc;

/// Build the application router.
pub fn router() -> Router {
    Router::new()
        .merge(health_routes())
        // The protocol, management and internal route groups land here as the M0 feature work
        // proceeds. They are separate functions so a reviewer can see the boundary at a glance
        // and so each can grow its own middleware without touching the others.
        .merge(protocol_routes())
        .merge(management_routes())
        .merge(internal_routes())
}

/// The generated OpenAPI document.
pub fn openapi_document() -> utoipa::openapi::OpenApi {
    <ApiDoc as utoipa::OpenApi>::openapi()
}

/// `/healthz` and `/version` — §6.1.
///
/// Liveness only: the endpoint answers `200` with `{"status":"ok"}` whenever the process can
/// serve, exactly as the gateway's own `/healthz` does, so the two are interchangeable to a
/// probe. A dependency check belongs on `/internal/health`, which is where §6.3 puts it.
pub fn health_routes() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/version", get(version))
}

/// The protocol endpoints — §6.1. Populated in M0 feature step 4.
pub fn protocol_routes() -> Router {
    Router::new()
}

/// The `/v1` management API — §6.2. Populated in M0 feature steps 5 and 6.
pub fn management_routes() -> Router {
    Router::new()
}

/// `/internal/*` — §6.3. Populated in M0 feature step 5.
///
/// Kept in its own function so it is obvious at the mount point that this group is the one the
/// gateway must never proxy.
pub fn internal_routes() -> Router {
    Router::new()
}

/// `GET /healthz` — always `200` with `{"status":"ok"}`.
#[utoipa::path(
    get,
    path = "/healthz",
    tag = "meta",
    summary = "Liveness",
    description = "Always 200 with {\"status\":\"ok\"} while the process can serve.",
    responses(
        (status = 200, description = "The server is alive.", body = HealthResponse)
    )
)]
async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

/// `GET /version` — the crate version, as compiled.
#[utoipa::path(
    get,
    path = "/version",
    tag = "meta",
    summary = "Build version",
    responses(
        (status = 200, description = "The binary's name and version.", body = VersionResponse)
    )
)]
async fn version() -> Json<VersionResponse> {
    Json(VersionResponse {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// The `/healthz` body — §6.1.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct HealthResponse {
    /// Always `"ok"`; the endpoint does not answer otherwise.
    pub status: &'static str,
}

/// The `/version` body.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct VersionResponse {
    /// The binary's package name.
    pub name: &'static str,
    /// The version it was built from.
    pub version: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_health_body_is_exactly_the_contract_shape() {
        let value = serde_json::to_value(HealthResponse { status: "ok" }).expect("serializes");
        assert_eq!(value, serde_json::json!({"status": "ok"}));
    }

    #[test]
    fn the_version_body_names_the_binary() {
        let value = serde_json::to_value(VersionResponse {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
        })
        .expect("serializes");
        assert_eq!(value["name"], "monaca-server");
        assert!(value["version"].as_str().expect("version").contains('.'));
    }
}
