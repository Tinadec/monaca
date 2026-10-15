//! Persistence: migrations, provisioning, the org transaction boundary and the outbox.
//!
//! **Stage 0 is a stub.** The types below fix the shape the rest of the workspace will build
//! against; the implementations land with the M0 feature work (plan §10 step 2, "存储与租户").
//!
//! The two rules this crate exists to enforce are worth stating here, because a stub is where
//! they would otherwise get lost:
//!
//! * **`tenant` is always written fully qualified; `org_<short>` is never written qualified.**
//!   [`OrgCtx`](monaca_types::OrgCtx) carries the schema and role names, and every org query runs
//!   inside [`with_org_tx`], which sets `search_path` and `SET LOCAL ROLE` for the transaction.
//!   The role grants are the real boundary; `search_path` is defence in depth, so a wrong
//!   `search_path` still cannot read another org (§5.1).
//! * **`CREATE DATABASE` cannot run in a transaction**, so tenant provisioning is a resumable
//!   state machine whose state is the `tenants.state` column, and every step is idempotent (§5.4).
//! * **`monaca_app` is created `NOINHERIT`.** A plain `GRANT org_role TO monaca_app` defaults to
//!   `INHERIT TRUE`, which hands the login role the union of every org's privileges the moment
//!   the grant runs — spike 2 (`scripts/spikes/embedded-pg.ts`) verified that a connection
//!   skipping `SET LOCAL ROLE` then reads another org's rows, and that `WITH INHERIT FALSE`
//!   closes exactly that hole while leaving the `SET LOCAL ROLE` path working (§5.1, §5.5). The
//!   grants are the boundary only because the role never inherits.
//!
//! M0 roadmap:
//! 1. `ControlStore` / `TenantStore` — runtime queries only (`query_as` + `FromRow`); the
//!    workspace deliberately leaves sqlx's `macros` feature off (§11.1).
//! 2. `Migrator` — the control, tenant and org migration sets, each recorded in `_migrations`
//!    and rolled up into `migration_rollup`.
//! 3. `TenantProvisioner` (saga) and `OrgProvisioner` (one transaction).
//! 4. `Router` — the LRU tenant+org cache, capped by `MONACA_TENANT_POOL_CACHE`.
//! 5. `outbox` — the insert half; the relay is M2.
//! 6. `with_org_tx` — the only way to run an org query.
//!
//! M1 adds connection pooling per tenant and the cross-org denial tests plan §13 requires.

use monaca_types::OrgCtx;

/// A storage failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    /// The tenant is not registered in the control plane.
    #[error("unknown tenant `{0}`")]
    UnknownTenant(String),
    /// The organization is not registered in its tenant.
    #[error("unknown organization `{0}`")]
    UnknownOrg(String),
    /// A migration's checksum does not match what was recorded, so the file changed after it ran.
    #[error("migration {version} checksum mismatch: recorded {recorded}, computed {computed}")]
    MigrationChecksum {
        /// The migration version.
        version: i64,
        /// The checksum in `_migrations`.
        recorded: String,
        /// The checksum of the file on disk.
        computed: String,
    },
    /// Provisioning stopped part-way; the saga row still says `provisioning`.
    #[error("tenant provisioning is incomplete at step {0}")]
    ProvisioningIncomplete(u8),
    /// The database driver reported an error.
    #[error("database error: {0}")]
    Database(String),
}

/// The transaction boundary every org query runs inside — §5.1.
///
/// A `with_org_tx` implementation issues, in order:
///
/// ```sql
/// BEGIN;
/// SET LOCAL search_path = org_<oshort>, tenant;
/// SET LOCAL ROLE t<tshort>_o<oshort>;
/// -- … the caller's queries …
/// COMMIT;
/// ```
///
/// Stage 0 defines only the signature: the body needs the pool type, which arrives with the
/// first real store. It is declared now so that no caller is written against a different shape.
pub trait OrgTransaction {
    /// The error a transaction can fail with.
    type Error;

    /// Run `work` inside this org's transaction.
    fn with_org_tx<T, F>(&self, ctx: &OrgCtx, work: F) -> Result<T, Self::Error>
    where
        F: FnOnce() -> Result<T, Self::Error>;
}

/// The M0 outbox topic names. A module writes to `outbox`; the relay that publishes it is M2.
pub mod topics {
    /// An audit event that must reach the chain.
    pub const AUDIT: &str = "audit";
    /// A tenant was provisioned or changed state.
    pub const TENANT: &str = "tenant";
    /// An agent or grant changed.
    pub const AGENT: &str = "agent";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_stable_strings() {
        assert_eq!(topics::AUDIT, "audit");
        assert_eq!(topics::TENANT, "tenant");
        assert_eq!(topics::AGENT, "agent");
    }

    #[test]
    fn errors_render_a_useful_message() {
        assert!(
            StoreError::UnknownTenant("demo".into())
                .to_string()
                .contains("demo")
        );
        let mismatch = StoreError::MigrationChecksum {
            version: 3,
            recorded: "aaa".into(),
            computed: "bbb".into(),
        };
        assert!(mismatch.to_string().contains("migration 3"));
    }
}
