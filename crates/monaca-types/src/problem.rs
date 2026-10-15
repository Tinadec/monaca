//! RFC 9457 `application/problem+json` — docs/contracts/m0.md §6.1.
//!
//! Every error outside the OAuth token endpoint is rendered as a problem document carrying the
//! Monaca-specific machine code in `monaca_error_code`, so a client can branch on a stable
//! string without parsing prose.

use serde::{Deserialize, Serialize};

/// Base URI for the `type` member. `type` is a documentation URL, never a dereferenced one.
const TYPE_BASE: &str = "https://monaca.dev/errors/";

/// A machine-readable error kind, mapped to its `type` slug and HTTP status.
///
/// The `code` is what appears in `monaca_error_code`; it is part of the wire contract, so
/// renaming a variant means updating the clients in the same change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProblemKind {
    slug: &'static str,
    code: &'static str,
    title: &'static str,
    status: u16,
}

impl ProblemKind {
    /// Build a kind. Not `const fn` callable from other crates' `const` items unless the
    /// constructor is `const`, so it is.
    pub const fn new(
        slug: &'static str,
        code: &'static str,
        title: &'static str,
        status: u16,
    ) -> Self {
        Self { slug, code, title, status }
    }

    /// The `type` slug, e.g. `grant_revoked`.
    pub const fn slug(&self) -> &'static str {
        self.slug
    }

    /// The `monaca_error_code`, e.g. `MONACA_GRANT_REVOKED`.
    pub const fn code(&self) -> &'static str {
        self.code
    }

    /// The human-readable `title`.
    pub const fn title(&self) -> &'static str {
        self.title
    }

    /// The HTTP status this kind maps to.
    pub const fn status(&self) -> u16 {
        self.status
    }
}

/// A rendered problem document.
///
/// `instance` is the request path the error is about; it is optional because a problem raised
/// before routing has no path to name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    /// Documentation URI for this kind.
    #[serde(rename = "type")]
    pub type_uri: String,
    /// Short, human-readable summary; identical for every occurrence of a kind.
    pub title: String,
    /// HTTP status code.
    pub status: u16,
    /// Occurrence-specific explanation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Request path this error is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// Stable machine code, e.g. `MONACA_GRANT_REVOKED`.
    pub monaca_error_code: String,
}

impl Problem {
    /// Build a problem from a kind, with occurrence-specific `detail`.
    pub fn new(kind: ProblemKind, detail: impl Into<String>) -> Self {
        Self {
            type_uri: format!("{TYPE_BASE}{}", kind.slug()),
            title: kind.title().to_owned(),
            status: kind.status(),
            detail: Some(detail.into()),
            instance: None,
            monaca_error_code: kind.code().to_owned(),
        }
    }

    /// Build a problem from a kind without a `detail`.
    pub fn without_detail(kind: ProblemKind) -> Self {
        Self {
            type_uri: format!("{TYPE_BASE}{}", kind.slug()),
            title: kind.title().to_owned(),
            status: kind.status(),
            detail: None,
            instance: None,
            monaca_error_code: kind.code().to_owned(),
        }
    }

    /// Attach the request path, as `instance`.
    #[must_use]
    pub fn with_instance(mut self, instance: impl Into<String>) -> Self {
        self.instance = Some(instance.into());
        self
    }

    /// Replace the `detail`.
    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// The HTTP status to answer with.
    pub fn status(&self) -> u16 {
        self.status
    }

    /// The stable machine code.
    pub fn code(&self) -> &str {
        &self.monaca_error_code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRANT_REVOKED: ProblemKind =
        ProblemKind::new("grant_revoked", "MONACA_GRANT_REVOKED", "Grant revoked", 409);

    #[test]
    fn kind_exposes_its_contract_values() {
        assert_eq!(GRANT_REVOKED.slug(), "grant_revoked");
        assert_eq!(GRANT_REVOKED.code(), "MONACA_GRANT_REVOKED");
        assert_eq!(GRANT_REVOKED.title(), "Grant revoked");
        assert_eq!(GRANT_REVOKED.status(), 409);
    }

    /// §6.1's worked example, asserted field by field.
    #[test]
    fn serializes_per_contract() {
        let problem = Problem::new(
            GRANT_REVOKED,
            "grant grt_00000000000000000000000000 was revoked at 2026-01-01T00:00:00Z",
        )
        .with_instance("/v1/orgs/acme/grants/01920000-0000-7000-8000-000000000000");

        let value: serde_json::Value = serde_json::to_value(&problem).expect("serializes");
        assert_eq!(value["type"], "https://monaca.dev/errors/grant_revoked");
        assert_eq!(value["title"], "Grant revoked");
        assert_eq!(value["status"], 409);
        assert_eq!(value["monaca_error_code"], "MONACA_GRANT_REVOKED");
        assert_eq!(
            value["instance"],
            "/v1/orgs/acme/grants/01920000-0000-7000-8000-000000000000"
        );
        assert!(value["detail"].as_str().expect("detail").contains("was revoked at"));
    }

    #[test]
    fn omitted_members_are_absent_not_null() {
        let value = serde_json::to_value(Problem::without_detail(GRANT_REVOKED)).expect("serializes");
        assert!(value.get("detail").is_none(), "detail must be omitted");
        assert!(value.get("instance").is_none(), "instance must be omitted");
    }

    #[test]
    fn round_trips_through_serde() {
        let problem = Problem::new(GRANT_REVOKED, "detail").with_instance("/v1/x");
        let json = serde_json::to_string(&problem).expect("serializes");
        let back: Problem = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(back, problem);
    }
}
