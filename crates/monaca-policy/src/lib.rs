//! Scope decisions.
//!
//! M0 answers exactly one question — does a granted scope set satisfy a required one — and
//! answers it with [`scope_satisfies`], which is a pure function both the Rust server and the
//! napi layer call. Keeping it here (rather than in `monaca-core`) means the answer is identical
//! on both sides of the FFI boundary: `monaca-core` re-exports it, and `crates/monaca-napi`
//! binds that re-export.
//!
//! M1 adds Cedar: a versioned per-organization policy set evaluated by `cedar-policy`, reached
//! through the `cedar` feature. The M0 surface stays as-is; Cedar only decides the cases M0
//! would have denied.

mod scope;

pub use scope::{InvalidScope, is_valid_scope, scope_satisfies};

/// The M0 policy decision, kept as its own type so a caller cannot confuse "the scope check
/// said no" with "policy evaluation failed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The requested action is permitted.
    Allow,
    /// The requested action is denied by policy.
    Deny,
}

impl Decision {
    /// Whether this decision permits the action.
    pub const fn is_allow(self) -> bool {
        matches!(self, Decision::Allow)
    }
}

#[cfg(feature = "cedar")]
mod cedar {
    //! M1: `cedar-policy` entry points.
    //!
    //! Intentionally empty in M0. The `cedar` feature exists so that enabling it in the
    //! workspace is a one-line change when the `policies` table (§5.7) starts being read,
    //! rather than a change that has to touch every downstream caller.
}
