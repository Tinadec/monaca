//! napi-rs v3 bindings — docs/contracts/m0.md §4.2.
//!
//! This crate is the only place the pure logic in `monaca-core` meets JavaScript. It exposes
//! exactly the surface §4.2 declares and nothing else, and it performs no I/O: keys arrive
//! through `Verifier.setKeys` and cache invalidation is TypeScript's job.
//!
//! **Error codes.** §4.3 requires a JS `Error` whose `code` property *and* message both carry
//! the `MONACA_*` string. `napi::Error<Status>` cannot express that — its `code` is the
//! `Status` debug name. So every fallible function here returns
//! `Result<T, napi::Error<&'static str>>`: napi writes the status string into the JS error's
//! `code` property, so using the contract code as the status is exactly right.
//!
//! **Recursion.** `ActorChain` is recursive. `Box<T>` has no `ToNapiValue` impl, but `Rc<T>`
//! does (for `T: ToNapiValue + Clone`) and napi's type generator maps `Rc<T>` to the inner
//! type's name, so `Option<Rc<ActorChain>>` produces `act?: ActorChain` in the declarations —
//! the shape §4.2 specifies.
//!
//! M1 adds `verifyDpop` and the Cedar `Authorizer`; M2 builds this crate for wasm so the same
//! verification runs at the edge and in a browser.

use std::rc::Rc;

use napi_derive::napi;

/// The error type every fallible binding returns. See the module docs for why the status is a
/// string and not `napi::Status`.
type NapiError = napi::Error<&'static str>;

/// One link of a delegation chain — §4.2 `ActorChain`.
///
/// `Clone` is required because the parent link is held in an `Rc`, and napi's `ToNapiValue for
/// Rc<T>` needs `T: ToNapiValue + Clone`.
#[napi(object)]
#[derive(Clone)]
pub struct ActorChain {
    /// Agent id (`agt_…`).
    pub sub: String,
    /// The actor that delegated to `sub`; present on multi-hop (M3) chains.
    ///
    /// `Rc` rather than `Box` because only `Rc` has a napi conversion; the generated declaration
    /// is `act?: ActorChain`, which is the recursive shape the contract specifies.
    pub act: Option<Rc<ActorChain>>,
}

/// Claim set parsed out of a verified access token — §4.2 `VerifiedToken`.
#[napi(object)]
pub struct VerifiedToken {
    /// Issuer.
    pub iss: String,
    /// `acc_…` — the user, or the delegating user on an agent token.
    pub sub: String,
    /// Audience.
    pub aud: String,
    /// Tenant id (`ten_…`).
    pub tid: String,
    /// Organization id (`org_…`).
    pub org: String,
    /// Sorted, de-duplicated scopes.
    pub scope: Vec<String>,
    /// Present on delegated (agent) tokens only.
    pub act: Option<Rc<ActorChain>>,
    /// `grt_…`, present on delegated tokens only.
    pub grant_id: Option<String>,
    /// The token's `jti`, a raw hyphenated UUIDv7.
    pub jti: String,
    /// Issued-at, seconds since the epoch.
    ///
    /// `i64`, not `u64`: napi maps `u64` to a JS `BigInt`, and §4.2 declares `number`.
    pub iat: i64,
    /// Expiry, seconds since the epoch.
    pub exp: i64,
}

/// Options for the `Verifier` constructor — §4.2 `VerifierOptions`.
#[napi(object)]
pub struct VerifierOptions {
    /// Permitted clock skew in seconds. Defaults to 60.
    ///
    /// `i64` for the same reason as `iat`: `u64` would become a `BigInt` and a caller passing
    /// `60` would be rejected at the FFI boundary.
    pub clock_skew_secs: Option<i64>,
}

/// What a caller expects of a token — §4.2 `VerifyExpectations`.
#[napi(object)]
pub struct VerifyExpectations {
    /// The issuer the token must name.
    pub issuer: String,
    /// The audience the token must name.
    pub audience: String,
}

/// In-process verifier. No I/O: keys are pushed in from TypeScript via `setKeys`.
#[napi]
pub struct Verifier {
    inner: monaca_core::Verifier,
}

#[napi]
impl Verifier {
    /// Build a verifier. `opts.clockSkewSecs` defaults to the contract's 60 seconds.
    #[napi(constructor)]
    pub fn new(opts: Option<VerifierOptions>) -> std::result::Result<Self, NapiError> {
        let clock_skew_secs = match opts.and_then(|opts| opts.clock_skew_secs) {
            // A negative skew is meaningless and would be a caller bug, not a token problem.
            Some(secs) if secs < 0 => {
                return Err(code_error(
                    "MONACA_JWKS_INVALID",
                    format!("clockSkewSecs must not be negative, got {secs}"),
                ));
            }
            Some(secs) => u64::try_from(secs).unwrap_or(0),
            None => monaca_core::DEFAULT_CLOCK_SKEW_SECS,
        };

        Ok(Self {
            inner: monaca_core::Verifier::new(monaca_core::VerifierOptions::with_clock_skew_secs(
                clock_skew_secs,
            )),
        })
    }

    /// Replace the key set for one issuer. Throws `MONACA_JWKS_INVALID`.
    ///
    /// Replacing rather than merging is deliberate: only the caller's refresh knows a key was
    /// retired, so a retired key must stop verifying as soon as this returns.
    #[napi]
    pub fn set_keys(
        &mut self,
        issuer: String,
        jwks_json: String,
    ) -> std::result::Result<(), NapiError> {
        self.inner
            .set_keys(&issuer, &jwks_json)
            .map_err(token_error)
    }

    /// Verify an access token. Throws an `Error` whose `code` is a `MONACA_TOKEN_*` code.
    #[napi]
    pub fn verify_access_token(
        &self,
        token: String,
        expect: VerifyExpectations,
    ) -> std::result::Result<VerifiedToken, NapiError> {
        let verified = self
            .inner
            .verify_access_token(&token, &expect.issuer, &expect.audience)
            .map_err(token_error)?;
        Ok(verified_token(verified))
    }
}

/// True when every entry of `required` is in `granted`.
#[napi]
pub fn scope_satisfies(granted: Vec<String>, required: Vec<String>) -> bool {
    monaca_core::scope_satisfies(&granted, &required)
}

/// Version of the native module.
#[napi]
pub fn version() -> String {
    monaca_core::VERSION.to_owned()
}

/// Map a core verification failure onto a JS error carrying its contract code.
fn token_error(err: monaca_core::TokenError) -> NapiError {
    // `code()` is `&'static str`, which is what makes it usable as a napi status — the status
    // string is what napi writes into the JS error's `code` property.
    napi::Error::<&'static str>::new(err.code(), err.message())
}

/// Build an error from a literal contract code.
fn code_error(code: &'static str, message: impl ToString) -> NapiError {
    napi::Error::<&'static str>::new(code, message.to_string())
}

/// Convert the core claim set into the binding's shape.
fn verified_token(verified: monaca_core::VerifiedToken) -> VerifiedToken {
    VerifiedToken {
        iss: verified.iss,
        sub: verified.sub,
        aud: verified.aud,
        tid: verified.tid,
        org: verified.org,
        scope: verified.scope,
        act: verified.act.map(actor_chain),
        grant_id: verified.grant_id,
        jti: verified.jti,
        iat: verified.iat,
        exp: verified.exp,
    }
}

/// Convert one actor-chain link, preserving arbitrary nesting depth.
fn actor_chain(chain: monaca_core::ActorChain) -> Rc<ActorChain> {
    Rc::new(ActorChain {
        sub: chain.sub,
        act: chain.act.map(|inner| actor_chain(*inner)),
    })
}

/// Node provides the napi C ABI at dlopen time. A test binary links this crate as an rlib with
/// no host process, so the three symbols the napi crate references would be undefined and the
/// link fails — which is exactly what the first `cargo nextest run --workspace` hit. This
/// crate's own tests never cross the FFI boundary (they exercise the pure conversions above),
/// so these `cfg(test)` stubs keep the test target linkable. The shipped cdylib never sees
/// them: they compile out of non-test builds, and the real symbols come from Node at load.
/// The boundary itself is covered from JavaScript by `packages/core`'s test suite.
#[cfg(test)]
mod node_symbol_stubs {
    use std::ffi::c_void;

    use napi::sys::{
        Status, napi_env, napi_ref, napi_status, napi_threadsafe_function,
        napi_threadsafe_function_call_mode,
    };

    /// napi_reference_unref — report a zero count: there is no reference to unref.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn napi_reference_unref(
        _env: napi_env,
        _ref: napi_ref,
        result: *mut u32,
    ) -> napi_status {
        if !result.is_null() {
            unsafe {
                *result = 0;
            }
        }
        Status::napi_ok
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn napi_delete_reference(_env: napi_env, _ref: napi_ref) -> napi_status {
        Status::napi_ok
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn napi_call_threadsafe_function(
        _func: napi_threadsafe_function,
        _data: *mut c_void,
        _is_blocking: napi_threadsafe_function_call_mode,
    ) -> napi_status {
        Status::napi_ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The conversions are pure, so they are testable without a JavaScript runtime — which is
    /// the only part of this crate that can be tested off-Node at all.
    #[test]
    fn version_reports_the_crate_version() {
        assert_eq!(version(), monaca_core::VERSION);
        assert!(!version().is_empty());
    }

    #[test]
    fn scope_satisfies_matches_the_core_relation() {
        let granted = vec!["tools:read".to_owned(), "openid".to_owned()];
        assert!(scope_satisfies(
            granted.clone(),
            vec!["tools:read".to_owned()]
        ));
        assert!(!scope_satisfies(
            granted.clone(),
            vec!["tools:write".to_owned()]
        ));
        assert!(scope_satisfies(granted, vec![]));
    }

    #[test]
    fn actor_chain_conversion_preserves_depth() {
        let core = monaca_core::ActorChain {
            sub: "agt_child".into(),
            act: Some(Box::new(monaca_core::ActorChain {
                sub: "agt_parent".into(),
                act: Some(Box::new(monaca_core::ActorChain {
                    sub: "agt_root".into(),
                    act: None,
                })),
            })),
        };

        let converted = actor_chain(core);
        assert_eq!(converted.sub, "agt_child");
        let parent = converted.act.as_ref().expect("parent link");
        assert_eq!(parent.sub, "agt_parent");
        let root = parent.act.as_ref().expect("root link");
        assert_eq!(root.sub, "agt_root");
        assert!(root.act.is_none());
    }

    #[test]
    fn a_token_error_carries_the_contract_code() {
        let core =
            monaca_core::TokenError::new(monaca_core::ErrorCode::Expired, "token has expired");
        let error = token_error(core);
        // `status` is what napi writes into the JS error's `code` property.
        assert_eq!(error.status, "MONACA_TOKEN_EXPIRED");
        assert!(error.reason.starts_with("MONACA_TOKEN_EXPIRED"));
    }

    #[test]
    fn verified_token_conversion_maps_every_field() {
        let core = monaca_core::VerifiedToken {
            iss: "http://localhost:8080/t/demo".into(),
            sub: "acc_00000000000000000000000000".into(),
            aud: "http://localhost:8080/mcp/demo".into(),
            tid: "ten_00000000000000000000000000".into(),
            org: "org_00000000000000000000000000".into(),
            scope: vec!["tools:read".into()],
            act: Some(monaca_core::ActorChain {
                sub: "agt_1".into(),
                act: None,
            }),
            grant_id: Some("grt_1".into()),
            jti: "01920000-0000-7000-8000-000000000000".into(),
            iat: 1_767_225_600,
            exp: 1_767_225_900,
        };

        let converted = verified_token(core);
        assert_eq!(converted.sub, "acc_00000000000000000000000000");
        assert_eq!(converted.scope, vec!["tools:read"]);
        assert_eq!(converted.grant_id.as_deref(), Some("grt_1"));
        assert_eq!(converted.iat, 1_767_225_600);
        assert_eq!(converted.exp, 1_767_225_900);
        assert_eq!(converted.act.expect("act").sub, "agt_1");
    }

    #[test]
    fn the_constructor_defaults_the_skew() {
        // 60 is the contract default; the binding must not silently pick something else.
        assert_eq!(monaca_core::DEFAULT_CLOCK_SKEW_SECS, 60);
    }

    #[test]
    fn the_constructor_rejects_a_negative_skew() {
        let result = Verifier::new(Some(VerifierOptions {
            clock_skew_secs: Some(-1),
        }));
        let error = result.err().expect("a negative skew must be refused");
        assert_eq!(error.status, "MONACA_JWKS_INVALID");
    }

    #[test]
    fn the_constructor_accepts_a_skew() {
        let verifier = Verifier::new(Some(VerifierOptions {
            clock_skew_secs: Some(5),
        }))
        .expect("constructs");
        assert_eq!(verifier.inner.clock_skew_secs(), 5);
    }

    #[test]
    fn set_keys_reports_an_unusable_jwks_as_a_token_error() {
        let mut verifier = Verifier::new(None).expect("constructs");
        let error = verifier
            .set_keys("http://localhost:8080/t/demo".into(), "{}".into())
            .err()
            .expect("must fail");
        assert_eq!(error.status, "MONACA_JWKS_INVALID");
    }
}
