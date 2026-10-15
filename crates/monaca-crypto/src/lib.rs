//! JWS/ES256 signing, argon2id password hashing, envelope encryption and key provisioning.
//!
//! This crate is the only place that touches key material. Everything above it works with
//! [`KeyProvider`] handles and sealed bytes, so a deployment can swap the dev environment
//! variable for KMS or Vault without any caller changing.
//!
//! **Stage 0 is a stub.** The types below fix the shape the rest of the workspace will build
//! against; the implementations land with the M0 feature work (plan §10 step 3, "密码学与密钥").
//! The `monaca-core` verifier deliberately does **not** depend on this crate: verification needs
//! only public keys, and keeping that path free of key material is what lets the napi module be
//! I/O-free.
//!
//! M0 roadmap:
//! 1. `SigningKeySet` — one active ES256 key per tenant, `kid` = the `signing_keys.id` row,
//!    with the private half sealed by the tenant DEK.
//! 2. `Jwks` — the public halves, served verbatim from `/t/{tenant}/.well-known/jwks.json`.
//! 3. `verify_jwt` — the server-side counterpart of `monaca-core`'s verifier, for the flows that
//!    run inside a request.
//! 4. `hash_password` / `verify_password` — argon2id at the §2.2 parameters, run through
//!    `spawn_blocking` behind a semaphore capped by `MONACA_ARGON2_MAX_CONCURRENCY`.
//! 5. `seal` / `open` — envelope encryption, per-tenant DEK wrapped by the platform KEK.
//!
//! M1 adds key rotation and `private_key_jwt` client assertions; the `fips` feature swaps the
//! RustCrypto backend for `aws-lc-rs`.

/// Where a tenant's data-encryption key comes from.
///
/// The dev implementation reads `MONACA_DEV_KEK`; production binds a KMS or Vault handle. The
/// trait is async-free on purpose: a provider that needs I/O can do it once at construction and
/// hold the resolved handle.
pub trait KeyProvider: Send + Sync + 'static {
    /// The 32-byte key-encryption key that wraps per-tenant DEKs.
    fn platform_kek(&self) -> &[u8; 32];

    /// The wrapped data-encryption key for `tenant`, or `None` before provisioning.
    fn tenant_dek(&self, tenant: &monaca_types::TenantId) -> Option<&[u8]>;
}

/// A cryptographic failure.
///
/// One enum for the crate rather than one per operation: every caller above turns these into a
/// problem document, and the distinctions that matter to a caller (bad password, unusable key,
/// failed decryption) are the variants, not the operation that hit them.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    /// The key material was the wrong length or shape.
    #[error("unusable key material: {0}")]
    KeyMaterial(String),
    /// The provider has no key for this tenant yet.
    #[error("no data-encryption key for this tenant")]
    TenantKeyMissing,
    /// Sealed bytes did not authenticate.
    #[error("sealed value failed authentication")]
    Decryption,
    /// A password hash could not be produced.
    #[error("password hashing failed")]
    Hashing,
    /// The supplied password does not match the stored hash.
    #[error("password does not match")]
    PasswordMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_render_a_useful_message() {
        assert!(CryptoError::TenantKeyMissing.to_string().contains("data-encryption key"));
        assert!(CryptoError::PasswordMismatch.to_string().contains("does not match"));
    }

    /// The trait is object-safe, which is what lets a deployment pick a provider at runtime.
    #[test]
    fn key_provider_is_object_safe() {
        fn assert_object_safe(_: &dyn KeyProvider) {}
        let _ = assert_object_safe;
    }
}
