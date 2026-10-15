//! The chain primitive — docs/contracts/m0.md §8.2.
//!
//! ```text
//! hash = hex(sha256(prev_hash_bytes || jcs_bytes))
//! ```
//!
//! `prev_hash_bytes` is the raw 32 bytes of the previous digest, not its hex string; `jcs_bytes`
//! is the UTF-8 RFC 8785 output with no trailing newline. Genesis is 32 zero bytes.

use sha2::{Digest, Sha256};

use crate::event::AuditEvent;

/// The genesis `prev_hash`: 32 zero bytes, i.e. 64 zero hex characters.
pub const GENESIS_HASH: [u8; 32] = [0u8; 32];

/// The stored members §8.2 excludes from the canonical bytes.
pub const CHAIN_FIELDS: [&str; 3] = ["seq", "prev_hash", "hash"];

/// The RFC 8785 canonical bytes of an event — §8.2.
///
/// §8.1's "everything else in this object is included verbatim" is structural here:
/// [`AuditEvent`] has no `seq`, `prev_hash` or `hash` field, so there is no way for this
/// function to serialize one. The exclusion cannot be forgotten because there is nothing to
/// exclude.
pub fn canonical_bytes(event: &AuditEvent) -> Result<Vec<u8>, CanonicalizeError> {
    serde_jcs::to_vec(event).map_err(|err| CanonicalizeError(err.to_string()))
}

/// The digest of `event` chained onto `prev`.
///
/// `prev` is the raw 32-byte digest of the previous event, or [`GENESIS_HASH`] for the first.
pub fn chain_hash(
    prev: &[u8; 32],
    event: &AuditEvent,
) -> Result<[u8; 32], CanonicalizeError> {
    let jcs = canonical_bytes(event)?;
    let mut hasher = Sha256::new();
    hasher.update(prev);
    hasher.update(&jcs);
    // `finalize()` yields `GenericArray<u8, U32>`, whose `Into<[u8; 32]>` impl is gated behind
    // `generic-array`'s `relaxed_coherence` feature and is therefore not available here. Copying
    // out of the slice is the portable path, and it is what every RustCrypto consumer does.
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_slice());
    Ok(out)
}

/// Lowercase hex of a digest — §8.2: "always lowercase hex, 64 characters".
pub fn hash_hex(hash: &[u8; 32]) -> String {
    hex::encode(hash)
}

/// An event that could not be canonicalized.
///
/// RFC 8785 cannot represent every `serde_json::Value` — a number with no shortest round-trip
/// form, or a non-BMP key ordering — so serialization can genuinely fail, and a chain must not
/// silently skip an event it cannot hash.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("event could not be canonicalized as RFC 8785 JCS: {0}")]
pub struct CanonicalizeError(pub String);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{AuditActor, AuditDecision, AuditEvent, AuditSubject};
    use monaca_types::{AccountId, EventId};
    use time::OffsetDateTime;

    fn event(action: &str, payload: serde_json::Value) -> AuditEvent {
        AuditEvent {
            id: EventId::new(),
            at: OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("timestamp"),
            action: action.into(),
            actor_chain: vec![AuditActor::account(AccountId::new())],
            subject: AuditSubject { subject_type: AuditActorType::Tool, id: None },
            decision: AuditDecision::Allow,
            grant_id: None,
            jti: None,
            payload,
        }
    }

    use crate::event::AuditActorType;

    #[test]
    fn genesis_is_64_zero_hex_characters() {
        assert_eq!(GENESIS_HASH, [0u8; 32]);
        assert_eq!(hash_hex(&GENESIS_HASH), "0".repeat(64));
        assert_eq!(hash_hex(&GENESIS_HASH).len(), 64);
    }

    #[test]
    fn hash_is_lowercase_hex_of_64_characters() {
        let digest = chain_hash(&GENESIS_HASH, &event("tool.invoked", serde_json::json!({})))
            .expect("hashes");
        let text = hash_hex(&digest);
        assert_eq!(text.len(), 64);
        assert!(text.chars().all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch)));
        assert_eq!(text, text.to_lowercase());
    }

    /// The digest depends on `prev`, so the same event at a different position differs — this is
    /// what makes a reorder detectable.
    #[test]
    fn the_digest_changes_with_the_previous_hash() {
        let event = event("tool.invoked", serde_json::json!({"a": 1}));
        let first = chain_hash(&GENESIS_HASH, &event).expect("hashes");
        let other_prev = [1u8; 32];
        let second = chain_hash(&other_prev, &event).expect("hashes");
        assert_ne!(first, second);
    }

    /// Hashing is a pure function of the event: the same event hashes the same twice.
    #[test]
    fn hashing_is_deterministic() {
        let event = event("tool.invoked", serde_json::json!({"a": 1}));
        assert_eq!(
            chain_hash(&GENESIS_HASH, &event).expect("hashes"),
            chain_hash(&GENESIS_HASH, &event).expect("hashes")
        );
    }

    /// RFC 8785 sorts object members, so two spellings of the same payload hash identically.
    #[test]
    fn canonicalization_ignores_member_order() {
        let left = event("tool.invoked", serde_json::json!({"b": 2, "a": 1}));
        let right = event("tool.invoked", serde_json::json!({"a": 1, "b": 2}));
        assert_eq!(
            canonical_bytes(&left).expect("canonicalizes"),
            canonical_bytes(&right).expect("canonicalizes")
        );
    }

    /// RFC 8785 normalizes numbers to their shortest round-trip form, so `1.0` and `1` agree.
    #[test]
    fn canonicalization_normalizes_numbers() {
        let integral = event("tool.invoked", serde_json::json!({"n": 1}));
        let float = event("tool.invoked", serde_json::json!({"n": 1.0}));
        assert_eq!(
            canonical_bytes(&integral).expect("canonicalizes"),
            canonical_bytes(&float).expect("canonicalizes")
        );
    }

    /// A changed payload changes the digest — the property tamper detection rests on.
    #[test]
    fn a_changed_payload_changes_the_digest() {
        let original = event("tool.invoked", serde_json::json!({"scope": ["tools:read"]}));
        let mut tampered = original.clone();
        tampered.payload = serde_json::json!({"scope": ["tools:read", "monaca:admin"]});
        assert_ne!(
            chain_hash(&GENESIS_HASH, &original).expect("hashes"),
            chain_hash(&GENESIS_HASH, &tampered).expect("hashes")
        );
    }

    /// A changed claim changes the digest even when the payload is untouched.
    #[test]
    fn a_changed_action_or_decision_changes_the_digest() {
        let original = event("tool.invoked", serde_json::json!({"a": 1}));
        let baseline = chain_hash(&GENESIS_HASH, &original).expect("hashes");

        let mut different_action = original.clone();
        different_action.action = "tool.denied".into();
        assert_ne!(baseline, chain_hash(&GENESIS_HASH, &different_action).expect("hashes"));

        let mut different_decision = original.clone();
        different_decision.decision = AuditDecision::Deny;
        assert_ne!(baseline, chain_hash(&GENESIS_HASH, &different_decision).expect("hashes"));
    }

    /// The digest is over the raw previous bytes, not their hex: hashing the hex spelling gives a
    /// different answer, and every existing chain would fail to verify if this regressed.
    #[test]
    fn the_previous_hash_is_hashed_as_bytes_not_hex() {
        let event = event("tool.invoked", serde_json::json!({}));
        let raw = chain_hash(&GENESIS_HASH, &event).expect("hashes");

        let hex_of_genesis = hash_hex(&GENESIS_HASH);
        let mut hasher = Sha256::new();
        hasher.update(hex_of_genesis.as_bytes());
        hasher.update(canonical_bytes(&event).expect("canonicalizes"));
        let mut from_hex = [0u8; 32];
        from_hex.copy_from_slice(hasher.finalize().as_slice());

        assert_ne!(raw, from_hex, "the hex spelling must not produce the same digest");
    }

    #[test]
    fn the_chain_field_names_are_exactly_three() {
        assert_eq!(CHAIN_FIELDS, ["seq", "prev_hash", "hash"]);
    }

    /// The canonical bytes never contain a chain field, even when the payload mentions one.
    #[test]
    fn chain_fields_are_absent_from_the_canonical_bytes() {
        let event = event("tool.invoked", serde_json::json!({"note": "ok"}));
        let bytes = canonical_bytes(&event).expect("canonicalizes");
        let text = String::from_utf8(bytes).expect("utf-8");
        assert!(!text.contains("\"prev_hash\""));
        assert!(!text.contains("\"hash\""));
        assert!(!text.contains("\"seq\""));
    }

    #[test]
    fn a_payload_key_named_like_a_chain_field_is_still_hashed() {
        // A payload may legitimately carry a key called `hash` — the exclusion is about the
        // event's own members, not about names appearing anywhere in the JSON.
        let with_key = event("tool.invoked", serde_json::json!({"hash": "abc"}));
        let without = event("tool.invoked", serde_json::json!({}));
        assert_ne!(
            chain_hash(&GENESIS_HASH, &with_key).expect("hashes"),
            chain_hash(&GENESIS_HASH, &without).expect("hashes")
        );
    }
}
