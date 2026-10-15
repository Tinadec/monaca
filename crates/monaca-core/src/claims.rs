//! Token claims — docs/contracts/m0.md §7.1, §7.2 and §4.2.
//!
//! The wire claim set is the contract's; [`VerifiedToken`] is the shape the napi layer returns.
//! They are separate types because the wire form must tolerate claims this crate does not model
//! (an `id_token`'s `email`/`name`, a future `cnf`), while the returned shape must not: a
//! TypeScript caller reads named fields, so every field it can read has to be present and typed.

use serde::{Deserialize, Serialize};

/// One link of a delegation chain — `act` in §7.2.
///
/// `sub` is the typed `agt_…` string. Multi-hop nesting (`act.act`) is M3, but the verifier
/// handles arbitrary depth now, which is why this is recursive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorChain {
    /// Agent identity, `agt_…`.
    pub sub: String,
    /// The actor that delegated to `sub`; present on M3 multi-hop chains.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub act: Option<Box<ActorChain>>,
}

impl ActorChain {
    /// Depth of this chain: 1 for a single hop, 2 for `act.act`, and so on.
    ///
    /// Iterative rather than recursive so a token with an absurdly deep `act` cannot overflow
    /// the stack on a hostile input; the depth is bounded by the JSON parser's own nesting limit
    /// long before it could matter, but the walk should not be the thing that fails.
    pub fn depth(&self) -> usize {
        let mut depth = 1usize;
        let mut current = self.act.as_deref();
        while let Some(link) = current {
            depth += 1;
            current = link.act.as_deref();
        }
        depth
    }

    /// Flatten to outermost-first `sub` values — the order `actor_chain` uses in an audit event
    /// (§8.1).
    pub fn subs(&self) -> Vec<&str> {
        let mut subs = Vec::new();
        let mut current = Some(self);
        while let Some(link) = current {
            subs.push(link.sub.as_str());
            current = link.act.as_deref();
        }
        subs
    }
}

/// The claim set returned to TypeScript — §4.2.
///
/// `scope` is returned sorted and de-duplicated, matching the declaration in
/// `packages/core/index.d.ts`; the sorting is done after verification (see `verifier.rs`), so
/// two tokens with the same scopes in a different order produce the same value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedToken {
    /// Issuer, `{base}/t/{tenant}`.
    pub iss: String,
    /// `acc_…` — the user, or the delegating user on an agent token.
    pub sub: String,
    /// Audience the token was issued for.
    pub aud: String,
    /// Tenant id, `ten_…`.
    pub tid: String,
    /// Organization id, `org_…`.
    pub org: String,
    /// Sorted, de-duplicated scopes.
    pub scope: Vec<String>,
    /// Present on delegated (agent) tokens only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub act: Option<ActorChain>,
    /// `grt_…`, present on delegated tokens only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<String>,
    /// The token's `jti`: a raw hyphenated UUIDv7, no prefix (§5.2).
    pub jti: String,
    /// Issued-at, seconds since the epoch.
    pub iat: i64,
    /// Expiry, seconds since the epoch.
    pub exp: i64,
}

/// The wire form of an access-token claim set — §7.1 and §7.2.
///
/// Deserialization is deliberately permissive about unknown members and strict about the ones it
/// names: `Option` plus an explicit presence check in the verifier distinguishes "absent" from
/// "present but the wrong type", which the two different error codes require
/// (`MONACA_TOKEN_CLAIMS_INVALID` for both, but with a message that says which).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AccessTokenClaims {
    #[serde(default)]
    pub iss: Option<String>,
    #[serde(default)]
    pub sub: Option<String>,
    #[serde(default)]
    pub aud: Option<Audience>,
    #[serde(default)]
    pub tid: Option<String>,
    #[serde(default)]
    pub org: Option<String>,
    #[serde(default)]
    pub scope: Option<Scope>,
    #[serde(default)]
    pub act: Option<ActorChain>,
    #[serde(default)]
    pub grant_id: Option<String>,
    #[serde(default)]
    pub jti: Option<String>,
    #[serde(default)]
    pub iat: Option<i64>,
    #[serde(default)]
    pub exp: Option<i64>,
}

/// `aud` may be a string or an array of strings (RFC 7519 §4.1.3).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum Audience {
    /// A single audience.
    Single(String),
    /// Several audiences.
    Multiple(Vec<String>),
}

impl Audience {
    /// Whether `expected` is named by this claim.
    ///
    /// §6.2: "neither `aud` string nor any `aud` array entry equals `expect.audience`" is a
    /// mismatch, so this is an exact string comparison over every member.
    pub fn contains(&self, expected: &str) -> bool {
        match self {
            Audience::Single(value) => value == expected,
            Audience::Multiple(values) => values.iter().any(|value| value == expected),
        }
    }

    /// The audience reported to TypeScript. A multi-valued `aud` is joined with a space, which is
    /// how RFC 6749 §3.3 renders a set of scope-like values and is unambiguous here because an
    /// audience in this system is always a single URL.
    pub fn to_reported_string(&self) -> String {
        match self {
            Audience::Single(value) => value.clone(),
            Audience::Multiple(values) => values.join(" "),
        }
    }
}

/// `scope` may be a space-delimited string (§6.1's token response shape) or an array.
///
/// §7.1 shows an array in the claims example, but the same field is a space-delimited string in
/// the `client_credentials` response and in RFC 6749 §3.3. Accepting both means the verifier
/// cannot be defeated by a token whose issuer chose the other valid spelling.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum Scope {
    /// Space-delimited scopes.
    String(String),
    /// An explicit array.
    Array(Vec<String>),
}

impl Scope {
    /// The scopes, sorted and de-duplicated.
    pub fn normalized(&self) -> Vec<String> {
        let mut scopes: Vec<String> = match self {
            Scope::String(value) => value
                .split(' ')
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect(),
            Scope::Array(values) => values
                .iter()
                .flat_map(|value| value.split(' '))
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect(),
        };
        scopes.sort_unstable();
        scopes.dedup();
        scopes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_chain_depth_counts_hops() {
        let single = ActorChain {
            sub: "agt_a".into(),
            act: None,
        };
        assert_eq!(single.depth(), 1);

        let two = ActorChain {
            sub: "agt_b".into(),
            act: Some(Box::new(ActorChain {
                sub: "agt_a".into(),
                act: None,
            })),
        };
        assert_eq!(two.depth(), 2);

        let three = ActorChain {
            sub: "agt_c".into(),
            act: Some(Box::new(two.clone())),
        };
        assert_eq!(three.depth(), 3);
    }

    #[test]
    fn actor_chain_flattens_outermost_first() {
        let chain = ActorChain {
            sub: "agt_c".into(),
            act: Some(Box::new(ActorChain {
                sub: "agt_b".into(),
                act: Some(Box::new(ActorChain {
                    sub: "agt_a".into(),
                    act: None,
                })),
            })),
        };
        assert_eq!(chain.subs(), vec!["agt_c", "agt_b", "agt_a"]);
    }

    #[test]
    fn audience_accepts_a_string_or_an_array() {
        let single: Audience = serde_json::from_str("\"https://a.test\"").expect("string");
        assert!(single.contains("https://a.test"));
        assert!(!single.contains("https://b.test"));
        assert_eq!(single.to_reported_string(), "https://a.test");

        let multiple: Audience =
            serde_json::from_str("[\"https://a.test\",\"https://b.test\"]").expect("array");
        assert!(multiple.contains("https://a.test"));
        assert!(multiple.contains("https://b.test"));
        assert!(!multiple.contains("https://c.test"));
        assert_eq!(
            multiple.to_reported_string(),
            "https://a.test https://b.test"
        );
    }

    #[test]
    fn scope_is_normalized_from_both_spellings() {
        let from_string: Scope =
            serde_json::from_str("\"tools:write tools:read tools:read\"").expect("string");
        assert_eq!(from_string.normalized(), vec!["tools:read", "tools:write"]);

        let from_array: Scope =
            serde_json::from_str("[\"tools:write\",\"tools:read\"]").expect("array");
        assert_eq!(from_array.normalized(), vec!["tools:read", "tools:write"]);

        // An array entry may itself be space-delimited, and empty entries are dropped.
        let mixed: Scope =
            serde_json::from_str("[\"tools:read tools:write\",\"  \"]").expect("mixed");
        assert_eq!(mixed.normalized(), vec!["tools:read", "tools:write"]);

        let empty: Scope = serde_json::from_str("\"\"").expect("empty string");
        assert!(empty.normalized().is_empty());
    }

    #[test]
    fn claims_tolerate_unknown_members() {
        // An id_token carries `email`/`name`; the access-token parser must not choke on them.
        let claims: AccessTokenClaims = serde_json::from_str(
            r#"{"iss":"i","sub":"acc_x","aud":"a","tid":"ten_x","org":"org_x",
                "scope":["tools:read"],"jti":"01920000-0000-7000-8000-000000000000",
                "iat":1,"exp":2,"email":"a@b.c","name":"A"}"#,
        )
        .expect("parses");
        assert_eq!(claims.iss.as_deref(), Some("i"));
    }

    #[test]
    fn a_wrongly_typed_claim_fails_to_deserialize() {
        // `exp` as a string is not an integer; the verifier turns this into
        // MONACA_TOKEN_CLAIMS_INVALID rather than a panic.
        let result: Result<AccessTokenClaims, _> = serde_json::from_str(r#"{"exp":"later"}"#);
        assert!(result.is_err(), "a string exp must not deserialize as i64");
    }
}
