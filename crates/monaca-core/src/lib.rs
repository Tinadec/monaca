//! I/O-free facade for the napi layer — docs/contracts/m0.md §4.2.
//!
//! This crate holds the pure logic `@monaca/core` exposes to TypeScript: verifying a tenant's
//! ES256 access token against a JWKS that TypeScript pushed in, and answering the scope
//! question. It performs **no I/O** — no database, no network, no tokio runtime, no filesystem.
//! Keys arrive through [`Verifier::set_keys`] and cache invalidation is the caller's job, which
//! is what lets the same code run inside a Node/Bun process that has no async runtime at all.
//!
//! Every failure is a [`TokenError`] carrying one of the `MONACA_TOKEN_*` codes from §4.3, so
//! the napi layer can put the same string on the JS `Error` and in its message.
//!
//! M1 adds `verify_dpop` and the Cedar `Authorizer`; M2 compiles this crate to wasm so the
//! same verification runs at the edge and in a browser.

mod claims;
mod error;
mod jwks;
mod verifier;

pub use claims::{ActorChain, VerifiedToken};
pub use error::{ErrorCode, TokenError};
pub use jwks::KeySet;
pub use verifier::{Verifier, VerifierOptions};

/// The default clock skew, in seconds, when the caller does not name one — §2.2
/// `MONACA_CLOCK_SKEW_SECS`.
pub const DEFAULT_CLOCK_SKEW_SECS: u64 = 60;

/// Re-export of the M0 scope decision, so `monaca-napi` binds one symbol and the answer cannot
/// differ between the Rust server and the native verifier.
pub use monaca_policy::scope_satisfies;

/// The crate version, surfaced as `version()` on the napi module.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
