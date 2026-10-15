//! Request contexts — the tenant and organization a unit of work runs in.
//!
//! `TenantCtx` is what makes a pool/router lookup meaningful; `OrgCtx` is what makes
//! `with_org_tx` safe. Both are cheap `Copy` values built once at the HTTP edge and threaded
//! down, so no function below the edge has to re-derive a tenant from a string.

use uuid::Uuid;

use crate::id::{AccountId, ClientId, OrgId, TenantId};

/// The tenant a request is scoped to: the issuer's `{base}/t/{tenant}` component.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TenantCtx {
    /// Tenant primary key (`ten_…`).
    pub tenant_id: TenantId,
    /// Tenant slug, e.g. `demo`. Used in `iss` and in DB name derivation.
    pub slug: &'static str,
    /// Database name, `mt_<short>`.
    pub db_name: &'static str,
}

impl TenantCtx {
    /// Build a context from a tenant id and its slug.
    ///
    /// `db_name` is derived from `short` by the caller (which already validated it), because
    /// deriving it here would need the control-plane row this struct deliberately does not hold.
    pub const fn new(tenant_id: TenantId, slug: &'static str, db_name: &'static str) -> Self {
        Self { tenant_id, slug, db_name }
    }
}

/// A tenant context plus the organization an org-scoped unit of work runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OrgCtx {
    /// The enclosing tenant.
    pub tenant: TenantCtx,
    /// Organization primary key (`org_…`).
    pub org_id: OrgId,
    /// Organization slug, e.g. `acme`.
    pub org_slug: &'static str,
    /// Schema holding this org's tables, `org_<oshort>`.
    pub schema_name: &'static str,
    /// The PG role `with_org_tx` assumes: `t<tshort>_o<oshort>`.
    pub role_name: &'static str,
}

impl OrgCtx {
    /// Build a context from its parts.
    pub const fn new(
        tenant: TenantCtx,
        org_id: OrgId,
        org_slug: &'static str,
        schema_name: &'static str,
        role_name: &'static str,
    ) -> Self {
        Self { tenant, org_id, org_slug, schema_name, role_name }
    }
}

/// Who the request is acting as, once authenticated.
///
/// `sub` stays the delegating account even on an agent token (§7.2); `agent_id` is the extra
/// hop. This mirrors the token's own shape so a handler never has to re-derive it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Principal {
    /// `acc_…` — the user, or the delegating user on an agent token.
    pub account_id: AccountId,
    /// `cli_…` — the client the token was issued to.
    pub client_id: ClientId,
    /// `agt_…`, present only on a delegated token.
    pub agent_id: Option<crate::id::AgentId>,
    /// Organization of this token, `org_…`.
    pub org_id: OrgId,
    /// The token's raw `jti`, a hyphenated UUIDv7 with no prefix (§5.2).
    pub jti: Uuid,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_ctx_carries_the_names_with_org_tx_needs() {
        let tenant = TenantCtx::new(TenantId::new(), "demo", "mt_demo");
        let org = OrgCtx::new(
            tenant,
            OrgId::new(),
            "acme",
            "org_acme",
            "tdemo_oacme",
        );
        assert_eq!(org.tenant.slug, "demo");
        assert_eq!(org.schema_name, "org_acme");
        assert_eq!(org.role_name, "tdemo_oacme");
    }

    #[test]
    fn principal_is_copy_and_compares_by_value() {
        let principal = Principal {
            account_id: AccountId::new(),
            client_id: ClientId::new(),
            agent_id: None,
            org_id: OrgId::new(),
            jti: Uuid::now_v7(),
        };
        let copy = principal;
        assert_eq!(copy, principal);
    }
}
