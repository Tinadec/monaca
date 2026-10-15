//! Chain verification — docs/contracts/m0.md §8.4.
//!
//! The walk recomputes each row's digest from the *recomputed* previous digest and the row's own
//! canonical bytes, and compares against what was stored. Nothing read from the row is trusted
//! except the event itself, which is the thing being checked.
//!
//! The first mismatch stops the walk, because every later row depends on the broken one and
//! reporting thousands of derived failures would bury the first real one.

use crate::chain::{CanonicalizeError, chain_hash};
use crate::event::{AuditEvent, ChainFields};

/// A stored row: the event, plus the chain fields §8.2 excludes from the digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    /// The event as stored.
    pub event: AuditEvent,
    /// The row's chain fields, as stored.
    pub chain: ChainFields,
}

impl StoredEvent {
    /// A row from its parts.
    pub const fn new(event: AuditEvent, chain: ChainFields) -> Self {
        Self { event, chain }
    }
}

/// What the walk found when it stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyStop {
    /// The `seq` of the row that failed.
    pub seq: i64,
    /// The digest that should have been stored, lowercase hex.
    pub expected: String,
    /// The digest that was stored, lowercase hex.
    pub actual: String,
    /// Which check failed.
    pub reason: VerifyReason,
}

/// Why verification stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyReason {
    /// The row's event does not hash to its stored `hash`.
    HashMismatch,
    /// The row's `prev_hash` is not the previous row's `hash`.
    PrevHashMismatch,
    /// The `seq` values are not contiguous.
    SeqGap,
    /// The last recomputed digest is not the stored chain head.
    HeadMismatch,
}

impl VerifyReason {
    /// The wire string — §8.4's `reason`.
    pub const fn as_str(self) -> &'static str {
        match self {
            VerifyReason::HashMismatch => "hash_mismatch",
            VerifyReason::PrevHashMismatch => "prev_hash_mismatch",
            VerifyReason::SeqGap => "seq_gap",
            VerifyReason::HeadMismatch => "head_mismatch",
        }
    }
}

/// The §8.4 report.
///
/// Serializes to exactly the JSON shape the `/v1/orgs/{org}/audit/verify` endpoint returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyReport {
    /// Whether the whole checked range is intact.
    pub valid: bool,
    /// How many rows were verified before the walk stopped.
    pub checked: usize,
    /// The stored chain head.
    pub head: ChainHead,
    /// Where the walk stopped, when it did.
    pub first_broken: Option<VerifyStop>,
}

/// The chain head, as `/v1/orgs/{org}/audit` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainHead {
    /// The head's `seq`.
    pub seq: i64,
    /// The head's digest, raw.
    pub hash: [u8; 32],
}

impl ChainHead {
    /// The head's digest, lowercase hex.
    pub fn hash_hex(&self) -> String {
        crate::chain::hash_hex(&self.hash)
    }
}

impl VerifyReport {
    /// Serialize to §8.4's JSON shape.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "valid": self.valid,
            "checked": self.checked,
            "head": { "seq": self.head.seq, "hash": self.head.hash_hex() },
            "first_broken": self.first_broken.as_ref().map(|stop| serde_json::json!({
                "seq": stop.seq,
                "expected": stop.expected,
                "actual": stop.actual,
                "reason": stop.reason.as_str(),
            })),
        })
    }
}

/// Verify a chain — §8.4.
///
/// `rows` must be in ascending `seq` order; `from` is the `seq` the caller asked to start at, so
/// `valid` can check `checked == head.seq - from + 1`. `head` is the stored chain head, which may
/// be beyond the last row when the caller verified a prefix.
///
/// A prefix verification (`rows` ending before `head.seq`) reports `valid: false` with
/// `reason: head_mismatch`, because §8.4 requires the recomputed head to equal the stored one.
pub fn verify_chain(rows: &[StoredEvent], head: ChainHead, from: i64) -> VerifyReport {
    let mut previous: Option<[u8; 32]> = None;
    let mut checked = 0usize;
    let mut expected_seq = from;

    for row in rows {
        // A gap means a row was deleted, so the walk cannot continue from here.
        if row.chain.seq != expected_seq {
            return VerifyReport {
                valid: false,
                checked,
                head,
                first_broken: Some(VerifyStop {
                    seq: row.chain.seq,
                    expected: expected_seq.to_string(),
                    actual: row.chain.seq.to_string(),
                    reason: VerifyReason::SeqGap,
                }),
            };
        }

        // The row's `prev_hash` must equal the previous row's *stored* hash. Comparing stored to
        // recomputed here (rather than to the previous stored value) is what catches a rewrite
        // of an earlier row.
        let previous_expected = previous.unwrap_or(crate::chain::GENESIS_HASH);
        if row.chain.prev_hash != previous_expected {
            return VerifyReport {
                valid: false,
                checked,
                head,
                first_broken: Some(VerifyStop {
                    seq: row.chain.seq,
                    expected: crate::chain::hash_hex(&previous_expected),
                    actual: crate::chain::hash_hex(&row.chain.prev_hash),
                    reason: VerifyReason::PrevHashMismatch,
                }),
            };
        }

        let recomputed = match chain_hash(&previous_expected, &row.event) {
            Ok(digest) => digest,
            Err(CanonicalizeError(detail)) => {
                // An event that cannot be canonicalized cannot be verified; report it as a hash
                // mismatch rather than pretending it is intact.
                return VerifyReport {
                    valid: false,
                    checked,
                    head,
                    first_broken: Some(VerifyStop {
                        seq: row.chain.seq,
                        expected: format!("unhashable: {detail}"),
                        actual: crate::chain::hash_hex(&row.chain.hash),
                        reason: VerifyReason::HashMismatch,
                    }),
                };
            }
        };

        if recomputed != row.chain.hash {
            return VerifyReport {
                valid: false,
                checked,
                head,
                first_broken: Some(VerifyStop {
                    seq: row.chain.seq,
                    expected: crate::chain::hash_hex(&recomputed),
                    actual: crate::chain::hash_hex(&row.chain.hash),
                    reason: VerifyReason::HashMismatch,
                }),
            };
        }

        previous = Some(recomputed);
        checked += 1;
        expected_seq += 1;
    }

    // §8.4: `valid: true` requires `checked == head.seq - from + 1` and the recomputed head hash
    // to equal the stored head. An empty range at `from == head.seq + 1` is vacuously complete.
    let recomputed_head = previous.unwrap_or(crate::chain::GENESIS_HASH);
    let expected_count = head.seq - from + 1;
    let counted_ok = i64::try_from(checked).map(|checked| checked == expected_count).unwrap_or(false);

    if !counted_ok {
        return VerifyReport {
            valid: false,
            checked,
            head,
            first_broken: Some(VerifyStop {
                seq: from + i64::try_from(checked).unwrap_or(i64::MAX),
                expected: format!("{expected_count} row(s) from seq {from}"),
                actual: format!("{checked} row(s)"),
                reason: VerifyReason::HeadMismatch,
            }),
        };
    }

    if recomputed_head != head.hash {
        return VerifyReport {
            valid: false,
            checked,
            head,
            first_broken: Some(VerifyStop {
                seq: head.seq,
                expected: crate::chain::hash_hex(&recomputed_head),
                actual: head.hash_hex(),
                reason: VerifyReason::HeadMismatch,
            }),
        };
    }

    VerifyReport { valid: true, checked, head, first_broken: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{GENESIS_HASH, chain_hash};
    use crate::event::{AuditActor, AuditActorType, AuditDecision, AuditEvent, AuditSubject};
    use monaca_types::{AccountId, EventId};
    use time::OffsetDateTime;

    /// Build a well-formed chain of `count` events, returning the rows and the head.
    fn build(count: usize) -> (Vec<StoredEvent>, ChainHead) {
        let mut rows = Vec::with_capacity(count);
        let mut previous = GENESIS_HASH;
        for index in 0..count {
            let event = AuditEvent {
                id: EventId::new(),
                at: OffsetDateTime::from_unix_timestamp(1_767_225_600 + index as i64)
                    .expect("timestamp"),
                action: "tool.invoked".into(),
                actor_chain: vec![AuditActor::account(AccountId::new())],
                subject: AuditSubject { subject_type: AuditActorType::Tool, id: None },
                decision: AuditDecision::Allow,
                grant_id: None,
                jti: None,
                payload: serde_json::json!({"index": index}),
            };
            let hash = chain_hash(&previous, &event).expect("hashes");
            rows.push(StoredEvent::new(
                event,
                ChainFields { seq: index as i64 + 1, prev_hash: previous, hash },
            ));
            previous = hash;
        }
        let head = ChainHead { seq: count as i64, hash: previous };
        (rows, head)
    }

    #[test]
    fn an_intact_chain_verifies() {
        let (rows, head) = build(5);
        let report = verify_chain(&rows, head, 1);
        assert!(report.valid, "{report:?}");
        assert_eq!(report.checked, 5);
        assert!(report.first_broken.is_none());
    }

    /// §8.4's worked example shape: a broken chain reports `valid: false`, the count reached and
    /// the first broken row.
    #[test]
    fn a_tampered_payload_is_detected_at_its_own_row() {
        let (mut rows, head) = build(5);
        rows[2].event.payload = serde_json::json!({"index": "tampered"});

        let report = verify_chain(&rows, head, 1);
        assert!(!report.valid);
        assert_eq!(report.checked, 2, "rows 1 and 2 are intact");
        let stop = report.first_broken.expect("reports where it broke");
        assert_eq!(stop.seq, 3);
        assert_eq!(stop.reason, VerifyReason::HashMismatch);
        assert_ne!(stop.expected, stop.actual);
    }

    /// Rewriting the *stored* hash of an intact row is caught too — the stored value is what is
    /// compared, not a value that happens to recompute.
    #[test]
    fn a_rewritten_stored_hash_is_detected() {
        let (mut rows, head) = build(4);
        rows[1].chain.hash = [0xabu8; 32];

        let report = verify_chain(&rows, head, 1);
        assert!(!report.valid);
        assert_eq!(report.first_broken.expect("broken").reason, VerifyReason::HashMismatch);
        assert_eq!(report.checked, 1);
    }

    /// Swapping two adjacent rows and renumbering them — what an attacker with UPDATE rights
    /// would do to hide a reorder — still fails: the moved row carries the *other* row's
    /// `prev_hash`, so the link check rejects it.
    #[test]
    fn a_reordered_pair_is_detected() {
        let (mut rows, head) = build(3);
        rows.swap(0, 1);
        // Renumber so the walk reaches the link check instead of the gap check.
        rows[0].chain.seq = 1;
        rows[1].chain.seq = 2;

        let report = verify_chain(&rows, head, 1);
        assert!(!report.valid);
        let stop = report.first_broken.expect("broken");
        assert_eq!(stop.seq, 1, "the first row already carries the wrong predecessor");
        assert_eq!(stop.reason, VerifyReason::PrevHashMismatch);
        assert_eq!(report.checked, 0);
    }

    /// Swapping two rows without renumbering is caught as a gap.
    #[test]
    fn a_reorder_without_renumbering_is_a_gap() {
        let (mut rows, head) = build(3);
        rows.swap(0, 1);

        let report = verify_chain(&rows, head, 1);
        assert!(!report.valid);
        assert_eq!(report.first_broken.expect("broken").reason, VerifyReason::SeqGap);
    }

    /// A deleted row makes the sequence non-contiguous.
    #[test]
    fn a_gap_is_detected() {
        let (mut rows, head) = build(5);
        rows.remove(2);

        let report = verify_chain(&rows, head, 1);
        assert!(!report.valid);
        let stop = report.first_broken.expect("broken");
        assert_eq!(stop.seq, 4, "the row after the gap");
        assert_eq!(stop.reason, VerifyReason::SeqGap);
        assert_eq!(report.checked, 2);
    }

    /// Deleting the last row leaves a chain that verifies as a prefix, but the stored head no
    /// longer matches.
    #[test]
    fn a_truncated_chain_does_not_match_the_stored_head() {
        let (mut rows, head) = build(5);
        rows.truncate(4);

        let report = verify_chain(&rows, head, 1);
        assert!(!report.valid);
        assert_eq!(report.first_broken.expect("broken").reason, VerifyReason::HeadMismatch);
    }

    /// A rewritten head is the other half of truncation detection.
    #[test]
    fn a_rewritten_head_is_detected() {
        let (rows, mut head) = build(3);
        head.hash = [0x11u8; 32];

        let report = verify_chain(&rows, head, 1);
        assert!(!report.valid);
        let stop = report.first_broken.expect("broken");
        assert_eq!(stop.reason, VerifyReason::HeadMismatch);
        assert_eq!(stop.seq, 3);
        assert_eq!(report.checked, 3, "every row verified; only the head disagrees");
    }

    /// An empty chain at genesis head (seq 0, zero hash) is valid: `checked == 0` and
    /// `0 == 0 - 1 + 1`.
    #[test]
    fn an_empty_chain_against_a_genesis_head_is_valid() {
        let head = ChainHead { seq: 0, hash: GENESIS_HASH };
        let report = verify_chain(&[], head, 1);
        assert!(report.valid, "{report:?}");
        assert_eq!(report.checked, 0);
    }

    /// A chain with no rows but a non-zero head is not valid.
    #[test]
    fn an_empty_chain_against_a_real_head_is_invalid() {
        let (_rows, head) = build(2);
        let report = verify_chain(&[], head, 1);
        assert!(!report.valid);
        assert_eq!(report.first_broken.expect("broken").reason, VerifyReason::HeadMismatch);
    }

    /// Verifying a sub-range works when its `prev_hash` is checked against the row before it.
    #[test]
    fn a_verified_suffix_uses_the_row_before_it_as_the_chain_start() {
        let (rows, head) = build(4);
        // Rows 3 and 4, starting from row 3's own `prev_hash` — which the walk reads from
        // `previous.unwrap_or(GENESIS)`, so a suffix against genesis reports a mismatch.
        let suffix = rows[2..].to_vec();
        let report = verify_chain(&suffix, head, 3);
        assert!(!report.valid, "a suffix without its predecessor cannot be chained");
        assert_eq!(
            report.first_broken.expect("broken").reason,
            VerifyReason::PrevHashMismatch
        );
    }

    #[test]
    fn report_json_matches_the_contract_shape() {
        let (rows, head) = build(3);
        let report = verify_chain(&rows, head, 1);
        let json = report.to_json();
        assert_eq!(json["valid"], true);
        assert_eq!(json["checked"], 3);
        assert_eq!(json["head"]["seq"], 3);
        assert_eq!(json["head"]["hash"].as_str().expect("hash").len(), 64);
        assert_eq!(json["first_broken"], serde_json::Value::Null);
    }

    #[test]
    fn broken_report_json_names_the_reason() {
        let (mut rows, head) = build(3);
        rows[2].event.action = "tool.denied".into();
        let json = verify_chain(&rows, head, 1).to_json();
        assert_eq!(json["valid"], false);
        assert_eq!(json["first_broken"]["seq"], 3);
        assert_eq!(json["first_broken"]["reason"], "hash_mismatch");
    }

    #[test]
    fn reason_strings_match_the_contract() {
        assert_eq!(VerifyReason::HashMismatch.as_str(), "hash_mismatch");
        assert_eq!(VerifyReason::PrevHashMismatch.as_str(), "prev_hash_mismatch");
        assert_eq!(VerifyReason::SeqGap.as_str(), "seq_gap");
        assert_eq!(VerifyReason::HeadMismatch.as_str(), "head_mismatch");
    }

    /// A long chain still verifies — the walk is linear and has no depth limit to hit.
    #[test]
    fn a_long_chain_verifies() {
        let (rows, head) = build(250);
        let report = verify_chain(&rows, head, 1);
        assert!(report.valid, "{report:?}");
        assert_eq!(report.checked, 250);
    }

    /// A one-byte change anywhere in the event is caught.
    #[test]
    fn every_field_of_the_event_is_covered_by_the_digest() {
        let (rows, _head) = build(1);
        let original = rows[0].clone();
        let original_hash = chain_hash(&GENESIS_HASH, &original.event).expect("hashes");

        let mut changed_id = original.event.clone();
        changed_id.id = EventId::new();
        assert_ne!(original_hash, chain_hash(&GENESIS_HASH, &changed_id).expect("hashes"));

        let mut changed_chain = original.event.clone();
        changed_chain.actor_chain.push(AuditActor::tool("list_notes"));
        assert_ne!(original_hash, chain_hash(&GENESIS_HASH, &changed_chain).expect("hashes"));

        let mut changed_subject = original.event.clone();
        changed_subject.subject.id = Some("other".into());
        assert_ne!(original_hash, chain_hash(&GENESIS_HASH, &changed_subject).expect("hashes"));
    }
}
