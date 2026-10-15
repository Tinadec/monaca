//! Verifier tests — docs/contracts/m0.md §4.3.
//!
//! These generate a real P-256 key, sign a real token with it, publish the matching JWKS and
//! verify. That is the only way to catch a key-format or algorithm mistake before CI: a mock
//! would pass while the real ES256 path is broken.
//!
//! The signing side uses `p256` directly rather than `jsonwebtoken`, so a bug in this crate's
//! use of jsonwebtoken cannot make a test agree with itself.

use data_encoding::BASE64URL_NOPAD;
use monaca_core::{
    DEFAULT_CLOCK_SKEW_SECS, ErrorCode, VERSION, Verifier, VerifierOptions, scope_satisfies,
};
use monaca_types::FixedClock;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use rand_core::OsRng;
use time::OffsetDateTime;

/// Base64url without padding — RFC 7515 §2's JWS segment encoding.
fn b64(input: &[u8]) -> String {
    BASE64URL_NOPAD.encode(input)
}

const ISSUER: &str = "http://localhost:8080/t/demo";
const AUDIENCE: &str = "http://localhost:8080/mcp/demo";
const OTHER_ISSUER: &str = "http://localhost:8080/t/other";
const OTHER_AUDIENCE: &str = "http://localhost:8080/mcp/other";
const KID: &str = "01920000-0000-7000-8000-0000000000aa";

/// A fixed instant well after the epoch, so the tests never depend on the wall clock.
fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("a valid timestamp")
}

/// A generated P-256 key pair plus the JWKS document that publishes its public half.
struct TestKey {
    signing: SigningKey,
    kid: String,
}

impl TestKey {
    fn generate(kid: &str) -> Self {
        Self {
            signing: SigningKey::random(&mut OsRng),
            kid: kid.to_owned(),
        }
    }

    fn verifying(&self) -> VerifyingKey {
        VerifyingKey::from(&self.signing)
    }

    /// The public half as a JWK, base64url without padding — RFC 7518 §6.2.1.2.
    fn jwk_json(&self, kid: &str) -> String {
        let point = self.verifying().to_encoded_point(false);
        let x = b64(point.x().expect("uncompressed point has x"));
        let y = b64(point.y().expect("uncompressed point has y"));
        format!(r#"{{"kty":"EC","crv":"P-256","kid":"{kid}","x":"{x}","y":"{y}"}}"#)
    }

    /// The JWKS document for this key.
    fn jwks_json(&self) -> String {
        format!(r#"{{"keys":[{}]}}"#, self.jwk_json(&self.kid))
    }

    /// Sign `claims` as an ES256 JWS compact token.
    fn sign(&self, header_json: &str, claims_json: &str) -> String {
        let header = b64(header_json.as_bytes());
        let payload = b64(claims_json.as_bytes());
        let signing_input = format!("{header}.{payload}");
        let signature: Signature = self.signing.sign(signing_input.as_bytes());
        let signature_bytes = signature.to_bytes();
        let signature = b64(signature_bytes.as_slice());
        format!("{signing_input}.{signature}")
    }
}

/// The standard header for a Monaca access token — §7.1.
fn header(kid: &str) -> String {
    format!(r#"{{"alg":"ES256","kid":"{kid}","typ":"at+jwt"}}"#)
}

/// A §7.1 user access token's claims, with `overrides` applied on top.
///
/// Building the JSON by hand (rather than serializing a struct) keeps these tests independent of
/// the claim struct they are testing.
fn claims_with(overrides: &[(&str, serde_json::Value)]) -> String {
    let mut map = serde_json::Map::new();
    map.insert("iss".into(), serde_json::json!(ISSUER));
    map.insert(
        "sub".into(),
        serde_json::json!("acc_00000000000000000000000000"),
    );
    map.insert("aud".into(), serde_json::json!(AUDIENCE));
    map.insert(
        "tid".into(),
        serde_json::json!("ten_00000000000000000000000000"),
    );
    map.insert(
        "org".into(),
        serde_json::json!("org_00000000000000000000000000"),
    );
    map.insert("scope".into(), serde_json::json!(["tools:read"]));
    map.insert(
        "jti".into(),
        serde_json::json!("01920000-0000-7000-8000-000000000000"),
    );
    map.insert("iat".into(), serde_json::json!(now().unix_timestamp()));
    map.insert(
        "exp".into(),
        serde_json::json!(now().unix_timestamp() + 900),
    );
    for (key, value) in overrides {
        map.insert((*key).to_owned(), value.clone());
    }
    serde_json::Value::Object(map).to_string()
}

/// A verifier holding one key for [`ISSUER`], frozen at [`now`].
fn verifier_with(key: &TestKey) -> Verifier {
    let mut verifier =
        Verifier::with_clock(VerifierOptions::default(), Box::new(FixedClock::new(now())));
    verifier
        .set_keys(ISSUER, &key.jwks_json())
        .expect("JWKS installs");
    verifier
}

#[test]
fn verifies_a_well_formed_user_token() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(&header(KID), &claims_with(&[]));

    let verified = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect("verifies");

    assert_eq!(verified.iss, ISSUER);
    assert_eq!(verified.sub, "acc_00000000000000000000000000");
    assert_eq!(verified.aud, AUDIENCE);
    assert_eq!(verified.tid, "ten_00000000000000000000000000");
    assert_eq!(verified.org, "org_00000000000000000000000000");
    assert_eq!(verified.scope, vec!["tools:read"]);
    assert_eq!(verified.jti, "01920000-0000-7000-8000-000000000000");
    assert_eq!(verified.iat, now().unix_timestamp());
    assert_eq!(verified.exp, now().unix_timestamp() + 900);
    assert!(verified.act.is_none(), "a user token has no act");
    assert!(verified.grant_id.is_none(), "a user token has no grant_id");
}

/// §7.2: an agent-delegated token keeps `sub` as the delegator and adds `act` and `grant_id`.
#[test]
fn verifies_a_delegated_token_and_reports_its_actor_chain() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[
            (
                "act",
                serde_json::json!({"sub": "agt_00000000000000000000000000"}),
            ),
            (
                "grant_id",
                serde_json::json!("grt_00000000000000000000000000"),
            ),
        ]),
    );

    let verified = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect("verifies");

    assert_eq!(
        verified.sub, "acc_00000000000000000000000000",
        "sub stays the delegator"
    );
    assert_eq!(
        verified.grant_id.as_deref(),
        Some("grt_00000000000000000000000000")
    );
    let act = verified.act.expect("act is present");
    assert_eq!(act.sub, "agt_00000000000000000000000000");
    assert_eq!(act.depth(), 1);
    assert!(act.act.is_none());
}

/// §7.2: "the verifier must already handle arbitrary depth", so a nested `act.act` verifies now.
#[test]
fn verifies_a_multi_hop_actor_chain() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[(
            "act",
            serde_json::json!({
                "sub": "agt_child",
                "act": {"sub": "agt_parent", "act": {"sub": "agt_root"}}
            }),
        )]),
    );

    let verified = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect("verifies");
    let act = verified.act.expect("act is present");
    assert_eq!(act.depth(), 3);
    assert_eq!(act.subs(), vec!["agt_child", "agt_parent", "agt_root"]);
}

#[test]
fn rejects_an_expired_token() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[("exp", serde_json::json!(now().unix_timestamp() - 3_600))]),
    );

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::Expired, "{err}");
}

/// The skew is a grace period, not a licence: a token that expired inside it still verifies.
#[test]
fn accepts_a_token_expired_within_the_clock_skew() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[("exp", serde_json::json!(now().unix_timestamp() - 30))]),
    );

    assert!(
        verifier
            .verify_access_token(&token, ISSUER, AUDIENCE)
            .is_ok()
    );
}

#[test]
fn rejects_a_token_that_is_not_yet_valid() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[("nbf", serde_json::json!(now().unix_timestamp() + 3_600))]),
    );

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::NotYetValid, "{err}");
}

/// §4.3: `iat` implausibly ahead is MONACA_TOKEN_NOT_YET_VALID.
#[test]
fn rejects_an_implausibly_future_iat() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let future = now().unix_timestamp() + 3_600;
    let token = key.sign(
        &header(KID),
        &claims_with(&[
            ("iat", serde_json::json!(future)),
            ("exp", serde_json::json!(future + 900)),
        ]),
    );

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::NotYetValid, "{err}");
}

#[test]
fn rejects_a_wrong_audience() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(&header(KID), &claims_with(&[]));

    let err = verifier
        .verify_access_token(&token, ISSUER, OTHER_AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::AudienceMismatch, "{err}");
}

#[test]
fn accepts_an_audience_array_containing_the_expected_value() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[("aud", serde_json::json!([OTHER_AUDIENCE, AUDIENCE]))]),
    );

    let verified = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect("verifies");
    assert!(verified.aud.contains(AUDIENCE));
}

/// `iss` must equal the expected issuer. The key set is loaded under `ISSUER`, so a token whose
/// `iss` names the *other* tenant is a signed-but-wrong-issuer token, not an unknown-kid one.
#[test]
fn rejects_a_wrong_issuer() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[("iss", serde_json::json!(OTHER_ISSUER))]),
    );

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::IssuerMismatch, "{err}");
}

/// Asking for an issuer with no keys loaded cannot succeed, whatever the token says.
#[test]
fn rejects_an_issuer_with_no_keys_loaded() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(&header(KID), &claims_with(&[]));

    let err = verifier
        .verify_access_token(&token, OTHER_ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::UnknownKid, "{err}");
}

/// A token whose `iss` disagrees with the issuer the keys were loaded under is rejected, even
/// though the signature is good — this is the case a merge-style key cache would let through.
#[test]
fn rejects_a_token_signed_by_another_issuers_key() {
    let demo_key = TestKey::generate(KID);
    let other_key = TestKey::generate(KID);

    let mut verifier =
        Verifier::with_clock(VerifierOptions::default(), Box::new(FixedClock::new(now())));
    verifier
        .set_keys(ISSUER, &demo_key.jwks_json())
        .expect("installs demo keys");
    verifier
        .set_keys(OTHER_ISSUER, &other_key.jwks_json())
        .expect("installs other keys");

    // Signed by the other tenant's key, but claiming to be the demo tenant's issuer.
    let token = other_key.sign(&header(KID), &claims_with(&[]));
    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::InvalidSignature, "{err}");
}

#[test]
fn rejects_an_unknown_kid() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header("01920000-0000-7000-8000-0000000000bb"),
        &claims_with(&[]),
    );

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::UnknownKid, "{err}");
}

#[test]
fn rejects_a_token_with_no_kid() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(r#"{"alg":"ES256","typ":"at+jwt"}"#, &claims_with(&[]));

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::UnknownKid, "{err}");
}

#[test]
fn rejects_an_unknown_issuer_with_no_keys() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(&header(KID), &claims_with(&[]));

    let err = verifier
        .verify_access_token(&token, OTHER_ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::UnknownKid, "{err}");
}

#[test]
fn rejects_a_tampered_signature() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(&header(KID), &claims_with(&[]));

    // Flip the FIRST character of the signature segment. `Signature` is a fixed 64-byte r||s,
    // so this changes the r coordinate's high bits; flipping the last character instead could
    // only touch base64 padding bits and might decode to the same bytes.
    let (signing_input, signature) = token.rsplit_once('.').expect("token has a signature");
    let mut chars: Vec<char> = signature.chars().collect();
    chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
    let tampered = format!("{signing_input}.{}", chars.into_iter().collect::<String>());

    assert_ne!(tampered, token, "the tamper must change the token");
    let err = verifier
        .verify_access_token(&tampered, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::InvalidSignature, "{err}");
}

/// Re-signing a *modified* payload with the right key is the interesting tamper case: the
/// signature is valid, so only the claim checks stand between the attacker and a forgery.
#[test]
fn a_re_signed_token_with_a_foreign_issuer_is_still_rejected() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[("iss", serde_json::json!(OTHER_ISSUER))]),
    );

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::IssuerMismatch, "{err}");
}

#[test]
fn rejects_a_tampered_payload() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(&header(KID), &claims_with(&[]));

    // Replace the payload with one that grants more, keeping the original signature.
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3, "a JWS compact token has three segments");
    let forged_payload =
        b64(
            claims_with(&[("scope", serde_json::json!(["tools:read", "monaca:admin"]))]).as_bytes(),
        );
    let forged = format!("{}.{}.{}", parts[0], forged_payload, parts[2]);

    let err = verifier
        .verify_access_token(&forged, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::InvalidSignature, "{err}");
}

#[test]
fn rejects_malformed_tokens() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);

    for token in [
        "",
        "not-a-token",
        "a.b",
        "a.b.c.d",
        "!!!.???.###",
        "eyJhbGciOiJFUzI1NiJ9..x",
    ] {
        let err = verifier
            .verify_access_token(token, ISSUER, AUDIENCE)
            .expect_err("must fail for {token}");
        assert!(
            matches!(err.code, ErrorCode::Malformed | ErrorCode::UnknownKid),
            "`{token}` gave {err}"
        );
    }
}

/// The classic algorithm-confusion attack: a header that asks for an algorithm this verifier
/// must never honour. `alg: none` does not even deserialize into `jsonwebtoken`'s `Algorithm`,
/// so it fails as malformed; either way it must never be accepted.
#[test]
fn rejects_a_non_es256_algorithm() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);

    for alg in ["none", "HS256", "RS256"] {
        let header_json = format!(r#"{{"alg":"{alg}","kid":"{KID}","typ":"at+jwt"}}"#);
        // Sign with the real key so only the header can be the reason for rejection.
        let token = key.sign(&header_json, &claims_with(&[]));

        let err = verifier
            .verify_access_token(&token, ISSUER, AUDIENCE)
            .expect_err(&format!("alg `{alg}` must be rejected"));
        assert!(
            matches!(err.code, ErrorCode::Malformed | ErrorCode::InvalidSignature),
            "alg `{alg}` gave {err}"
        );
    }
}

#[test]
fn rejects_missing_required_claims() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);

    // Every claim §7.1 requires of a user token. `scope` is deliberately absent from this list:
    // it is optional, and the test below covers that.
    for claim in ["sub", "tid", "org", "jti", "iat", "exp", "aud", "iss"] {
        let mut map: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&claims_with(&[])).expect("claims parse");
        map.remove(claim);
        let token = key.sign(&header(KID), &serde_json::Value::Object(map).to_string());

        let err = verifier
            .verify_access_token(&token, ISSUER, AUDIENCE)
            .expect_err(&format!("a token without `{claim}` must be rejected"));
        assert_eq!(err.code, ErrorCode::ClaimsInvalid, "`{claim}` gave {err}");
        assert!(
            err.detail.contains(claim),
            "`{claim}` error must name it: {err}"
        );
    }
}

/// `scope` is optional in the claim set; its absence means "no scopes", not "invalid".
#[test]
fn a_token_without_scope_verifies_with_an_empty_scope_set() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let mut map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&claims_with(&[])).expect("claims parse");
    map.remove("scope");
    let token = key.sign(&header(KID), &serde_json::Value::Object(map).to_string());

    let verified = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect("verifies");
    assert!(verified.scope.is_empty());
}

/// The scope array is normalized: sorted and de-duplicated, as `index.d.ts` promises.
#[test]
fn scope_is_sorted_and_deduplicated() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[(
            "scope",
            serde_json::json!(["tools:write", "openid", "tools:read", "openid"]),
        )]),
    );

    let verified = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect("verifies");
    assert_eq!(verified.scope, vec!["openid", "tools:read", "tools:write"]);
}

/// A space-delimited `scope` string is the other valid spelling (§6.1's token response).
#[test]
fn scope_accepts_the_space_delimited_string_form() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    let token = key.sign(
        &header(KID),
        &claims_with(&[("scope", serde_json::json!("tools:write tools:read"))]),
    );

    let verified = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect("verifies");
    assert_eq!(verified.scope, vec!["tools:read", "tools:write"]);
}

#[test]
fn rejects_a_claim_with_the_wrong_type() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    // `exp` as a string: the JSON parses but the claim is not an integer.
    let token = key.sign(
        &header(KID),
        &claims_with(&[("exp", serde_json::json!("soon"))]),
    );

    let err = verifier
        .verify_access_token(&token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert!(
        matches!(err.code, ErrorCode::ClaimsInvalid | ErrorCode::Malformed),
        "unexpected code {err}"
    );
}

#[test]
fn set_keys_rejects_an_unusable_jwks() {
    let mut verifier = Verifier::new(VerifierOptions::default());
    let err = verifier.set_keys(ISSUER, "{}").expect_err("must fail");
    assert_eq!(err.code, ErrorCode::JwksInvalid, "{err}");
}

#[test]
fn a_refreshed_key_set_replaces_the_old_keys() {
    let old_key = TestKey::generate(KID);
    let new_key = TestKey::generate("01920000-0000-7000-8000-0000000000cc");
    let mut verifier = verifier_with(&old_key);
    let old_token = old_key.sign(&header(KID), &claims_with(&[]));

    assert!(
        verifier
            .verify_access_token(&old_token, ISSUER, AUDIENCE)
            .is_ok()
    );

    verifier
        .set_keys(ISSUER, &new_key.jwks_json())
        .expect("refreshes");

    // The retired key must stop verifying immediately.
    let err = verifier
        .verify_access_token(&old_token, ISSUER, AUDIENCE)
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::UnknownKid, "{err}");
}

#[test]
fn options_default_to_the_contract_skew() {
    assert_eq!(
        VerifierOptions::default().clock_skew_secs,
        DEFAULT_CLOCK_SKEW_SECS
    );
    assert_eq!(DEFAULT_CLOCK_SKEW_SECS, 60);
    assert_eq!(Verifier::default().clock_skew_secs(), 60);
    assert_eq!(
        Verifier::new(VerifierOptions::with_clock_skew_secs(5)).clock_skew_secs(),
        5
    );
}

#[test]
fn issuer_count_tracks_set_keys() {
    let key = TestKey::generate(KID);
    let verifier = verifier_with(&key);
    assert_eq!(verifier.issuer_count(), 1);
    assert!(verifier.issuer_keys(ISSUER).is_some());
    assert!(verifier.issuer_keys(OTHER_ISSUER).is_none());
}

#[test]
fn scope_satisfies_is_re_exported_from_here() {
    // The napi layer binds this symbol, so it must be reachable from `monaca_core`.
    assert!(scope_satisfies(
        &["tools:read".to_owned()],
        &["tools:read".to_owned()]
    ));
    assert!(!scope_satisfies(
        &["tools:read".to_owned()],
        &["tools:write".to_owned()]
    ));
}

#[test]
fn version_is_reported() {
    assert!(!VERSION.is_empty());
}
