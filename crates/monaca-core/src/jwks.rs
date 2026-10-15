//! The key set TypeScript pushes in — docs/contracts/m0.md §4.2, §6.1.
//!
//! The native module never fetches a JWKS: `setKeys(issuer, jwksJson)` hands it the document the
//! gateway already fetched, and the gateway owns refresh. This type is therefore a plain
//! in-memory map from issuer to the ES256 keys of that issuer's `kid`s.

use std::collections::HashMap;

use jsonwebtoken::jwk::{AlgorithmParameters, EllipticCurve, Jwk, JwkSet};
use jsonwebtoken::DecodingKey;

use crate::error::{ErrorCode, TokenError};

/// One usable ES256 verification key.
#[derive(Debug, Clone)]
pub struct VerificationKey {
    /// The JWS `kid` this key answers to.
    pub kid: String,
    /// The prepared decoding key.
    pub key: DecodingKey,
}

/// The loaded keys for one issuer.
#[derive(Debug, Clone, Default)]
pub struct IssuerKeys {
    keys: HashMap<String, DecodingKey>,
}

impl IssuerKeys {
    /// How many keys this issuer has.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// Whether this issuer has no keys at all.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The key for `kid`, if this issuer has one.
    pub fn get(&self, kid: &str) -> Option<&DecodingKey> {
        self.keys.get(kid)
    }

    /// The `kid`s this issuer knows, sorted — useful in an error detail.
    pub fn kids(&self) -> Vec<&str> {
        let mut kids: Vec<&str> = self.keys.keys().map(String::as_str).collect();
        kids.sort_unstable();
        kids
    }
}

/// Every issuer the verifier has keys for.
#[derive(Debug, Clone, Default)]
pub struct KeySet {
    issuers: HashMap<String, IssuerKeys>,
}

impl KeySet {
    /// An empty key set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse a JWKS document and replace the key set for `issuer`.
    ///
    /// Replacing rather than merging is deliberate: the caller's refresh is the only thing that
    /// knows a key was retired, and a merge would keep a revoked key usable forever.
    pub fn insert_jwks(&mut self, issuer: &str, jwks_json: &str) -> Result<(), TokenError> {
        let keys = parse_jwks(jwks_json)?;
        self.issuers.insert(issuer.to_owned(), keys);
        Ok(())
    }

    /// The keys for `issuer`, if any have been pushed in.
    pub fn issuer(&self, issuer: &str) -> Option<&IssuerKeys> {
        self.issuers.get(issuer)
    }

    /// How many issuers are loaded.
    pub fn len(&self) -> usize {
        self.issuers.len()
    }

    /// Whether no issuer is loaded.
    pub fn is_empty(&self) -> bool {
        self.issuers.is_empty()
    }
}

/// Parse a JWKS document into the ES256 keys it holds.
///
/// A document that is not JSON, has no `keys` array, or holds no key this crate can verify ES256
/// with is [`ErrorCode::JwksInvalid`]: the caller asked to install a usable key set and got one
/// it cannot use, which is a configuration error worth surfacing immediately rather than at the
/// first verification.
pub fn parse_jwks(jwks_json: &str) -> Result<IssuerKeys, TokenError> {
    let set: JwkSet = serde_json::from_str(jwks_json)
        .map_err(|err| TokenError::new(ErrorCode::JwksInvalid, format!("not a JWKS: {err}")))?;

    let mut keys = HashMap::with_capacity(set.keys.len());
    let mut skipped = 0usize;

    for jwk in &set.keys {
        match usable_es256_key(jwk) {
            Ok(Some((kid, key))) => {
                keys.insert(kid, key);
            }
            // A key that is well-formed but not an ES256 signature key (an RSA key, an
            // encryption key, a private key) is skipped: a JWKS may legitimately carry keys this
            // verifier does not use.
            Ok(None) => skipped += 1,
            Err(reason) => {
                return Err(TokenError::new(
                    ErrorCode::JwksInvalid,
                    format!("unusable key: {reason}"),
                ));
            }
        }
    }

    if keys.is_empty() {
        return Err(TokenError::new(
            ErrorCode::JwksInvalid,
            format!("no usable ES256 key in JWKS ({skipped} key(s) skipped)"),
        ));
    }

    Ok(IssuerKeys { keys })
}

/// Extract an ES256 verification key from one JWK, or `Ok(None)` when the JWK is simply not one.
fn usable_es256_key(jwk: &Jwk) -> Result<Option<(String, DecodingKey)>, String> {
    // Only EC keys on P-256 can verify ES256.
    let AlgorithmParameters::EllipticCurve(params) = &jwk.algorithm else {
        return Ok(None);
    };
    if params.curve != EllipticCurve::P256 {
        return Ok(None);
    }
    // `kid` is how a token selects its key, so a key without one is unreachable.
    let Some(kid) = jwk.common.key_id.as_deref() else {
        return Ok(None);
    };
    if kid.is_empty() {
        return Ok(None);
    }

    let key = DecodingKey::from_jwk(jwk).map_err(|err| format!("kid `{kid}`: {err}"))?;
    Ok(Some((kid.to_owned(), key)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal, well-formed P-256 public JWK. The coordinates are the generator's, which is a
    /// perfectly valid public point; nothing here is used as a private key.
    const P256_X: &str = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU";
    const P256_Y: &str = "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0";

    fn jwks_json(kid: &str) -> String {
        format!(
            r#"{{"keys":[{{"kty":"EC","crv":"P-256","kid":"{kid}","x":"{P256_X}","y":"{P256_Y}"}}]}}"#
        )
    }

    #[test]
    fn parses_a_p256_jwks() {
        let keys = parse_jwks(&jwks_json("k1")).expect("parses");
        assert_eq!(keys.len(), 1);
        assert!(keys.get("k1").is_some());
        assert_eq!(keys.kids(), vec!["k1"]);
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_jwks("{not json").expect_err("must fail");
        assert_eq!(err.code, ErrorCode::JwksInvalid);
        assert!(err.detail.contains("not a JWKS"));
    }

    #[test]
    fn rejects_a_document_with_no_keys() {
        let err = parse_jwks(r#"{"keys":[]}"#).expect_err("must fail");
        assert_eq!(err.code, ErrorCode::JwksInvalid);
        assert!(err.detail.contains("no usable ES256 key"));
    }

    #[test]
    fn skips_keys_it_cannot_use() {
        // An RSA key and a P-384 key are valid JWKS members this verifier does not use; the
        // P-256 key alongside them must still load.
        let json = format!(
            r#"{{"keys":[
                {{"kty":"RSA","kid":"rsa","n":"AQAB","e":"AQAB"}},
                {{"kty":"EC","crv":"P-384","kid":"p384","x":"{P256_X}","y":"{P256_Y}"}},
                {{"kty":"EC","crv":"P-256","kid":"good","x":"{P256_X}","y":"{P256_Y}"}}
            ]}}"#
        );
        let keys = parse_jwks(&json).expect("parses");
        assert_eq!(keys.kids(), vec!["good"]);
    }

    #[test]
    fn a_key_without_a_kid_is_unreachable_and_skipped() {
        let json = format!(
            r#"{{"keys":[{{"kty":"EC","crv":"P-256","x":"{P256_X}","y":"{P256_Y}"}}]}}"#
        );
        let err = parse_jwks(&json).expect_err("must fail: no reachable key");
        assert_eq!(err.code, ErrorCode::JwksInvalid);
    }

    #[test]
    fn inserting_replaces_rather_than_merges() {
        let mut set = KeySet::new();
        set.insert_jwks("https://issuer.test/t/demo", &jwks_json("k1")).expect("inserts");
        assert_eq!(set.issuer("https://issuer.test/t/demo").expect("present").len(), 1);

        // A refresh that drops `k1` must drop it here too: a retired key must stop verifying.
        set.insert_jwks("https://issuer.test/t/demo", &jwks_json("k2")).expect("inserts");
        let keys = set.issuer("https://issuer.test/t/demo").expect("present");
        assert_eq!(keys.kids(), vec!["k2"]);
        assert!(keys.get("k1").is_none());
    }

    #[test]
    fn issuers_are_independent() {
        let mut set = KeySet::new();
        set.insert_jwks("https://a.test/t/x", &jwks_json("k1")).expect("inserts");
        set.insert_jwks("https://b.test/t/y", &jwks_json("k2")).expect("inserts");
        assert_eq!(set.len(), 2);
        assert!(set.issuer("https://a.test/t/x").expect("a").get("k1").is_some());
        assert!(set.issuer("https://b.test/t/y").expect("b").get("k1").is_none());
        assert!(set.issuer("https://c.test/t/z").is_none());
    }

    #[test]
    fn an_empty_key_set_is_empty() {
        let set = KeySet::new();
        assert!(set.is_empty());
        assert_eq!(set.len(), 0);
        assert!(set.issuer("anything").is_none());
    }

    #[test]
    fn a_failed_insert_leaves_the_previous_keys_untouched() {
        let mut set = KeySet::new();
        set.insert_jwks("https://issuer.test/t/demo", &jwks_json("k1")).expect("inserts");
        let err = set.insert_jwks("https://issuer.test/t/demo", "{bad").expect_err("must fail");
        assert_eq!(err.code, ErrorCode::JwksInvalid);
        // The good keys survive a bad refresh, so a transient fetch error does not blind the
        // verifier.
        assert_eq!(set.issuer("https://issuer.test/t/demo").expect("present").kids(), vec!["k1"]);
    }
}
