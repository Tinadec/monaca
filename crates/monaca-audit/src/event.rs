//! The audit event — docs/contracts/m0.md §8.1.
//!
//! The event is defined once here and used three ways: as the JSON Schema in `spec/events/`, as
//! the canonical input to the hash chain, and as the stored row. §8.2 excludes `seq`, `prev_hash`
//! and `hash` from the canonical bytes, which is why the chain fields live in their own struct
//! rather than as fields of [`AuditEvent`] — a field that is not there cannot be hashed by
//! accident.

use monaca_types::{AccountId, AgentId, EventId, GrantId, OrgId, TenantId, TypedId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

/// The `subject.type` values §8.1 allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditActorType {
    /// An account.
    Account,
    /// An organization.
    Org,
    /// An agent.
    Agent,
    /// An agent key.
    AgentKey,
    /// A grant.
    Grant,
    /// A client.
    Client,
    /// A tool invocation.
    Tool,
    /// A session.
    Session,
    /// A tenant.
    Tenant,
}

/// One entry of `actor_chain`, ordered outermost-first.
///
/// `id` is a typed id string, except for a `tool`, whose `id` is a bare tool name (§8.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditActor {
    /// What kind of actor this is.
    #[serde(rename = "type")]
    pub actor_type: AuditActorType,
    /// The typed id, or a tool name.
    pub id: String,
}

impl AuditActor {
    /// An account actor.
    pub fn account(id: AccountId) -> Self {
        Self {
            actor_type: AuditActorType::Account,
            id: id.to_typed_string(),
        }
    }

    /// An agent actor.
    pub fn agent(id: AgentId) -> Self {
        Self {
            actor_type: AuditActorType::Agent,
            id: id.to_typed_string(),
        }
    }

    /// A tenant actor.
    pub fn tenant(id: TenantId) -> Self {
        Self {
            actor_type: AuditActorType::Tenant,
            id: id.to_typed_string(),
        }
    }

    /// An organization actor.
    pub fn org(id: OrgId) -> Self {
        Self {
            actor_type: AuditActorType::Org,
            id: id.to_typed_string(),
        }
    }

    /// A tool actor; `name` is the bare tool name, not a typed id.
    pub fn tool(name: impl Into<String>) -> Self {
        Self {
            actor_type: AuditActorType::Tool,
            id: name.into(),
        }
    }
}

/// The `subject` object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditSubject {
    /// What kind of subject this is.
    #[serde(rename = "type")]
    pub subject_type: AuditActorType,
    /// The typed id string; `null` when the subject has no identity of its own.
    pub id: Option<String>,
}

/// The `decision` member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditDecision {
    /// The action was permitted.
    Allow,
    /// The action was refused.
    Deny,
    /// The action was recorded for information only.
    Info,
}

impl AuditDecision {
    /// The wire string, as the `decision` column stores it.
    pub const fn as_str(self) -> &'static str {
        match self {
            AuditDecision::Allow => "allow",
            AuditDecision::Deny => "deny",
            AuditDecision::Info => "info",
        }
    }
}

/// An audit event — §8.1, exactly the object the JSON Schema describes.
///
/// `at` serializes through `time`'s RFC 3339 implementation. §8.1 asks for millisecond
/// precision; `time`'s well-known RFC 3339 format drops trailing zeroes, so the canonical bytes
/// are stable for a given instant but not byte-identical to a hand-written `.000Z` form. That is
/// fine because both the append path and the verifier serialize through this type — but it is
/// why the digest is computed here rather than from the stored JSON text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEvent {
    /// The event's own id, `evt_…`.
    pub id: EventId,
    /// When it happened, UTC.
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// Dotted lowercase verb, e.g. `agent.token.issued`.
    pub action: String,
    /// Ordered outermost-first; never empty (§8.1).
    pub actor_chain: Vec<AuditActor>,
    /// What the action was about.
    pub subject: AuditSubject,
    /// The decision.
    pub decision: AuditDecision,
    /// `grt_…`, when the action was authorized by a grant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<GrantId>,
    /// The token's `jti` — a raw hyphenated UUIDv7, no prefix (§5.2's exception).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jti: Option<Uuid>,
    /// Event-specific detail; an object, never an array and never null (§8.1).
    pub payload: serde_json::Value,
}

impl AuditEvent {
    /// Whether this event satisfies the §8.1 invariants.
    ///
    /// The invariants are checked rather than enforced by the type because they are about the
    /// *stored* row, and a row can arrive from a migration, a fixture or an import — not only
    /// from a constructor. An event that fails this must never be appended.
    pub fn validate(&self) -> Result<(), EventInvalid> {
        if self.actor_chain.is_empty() {
            return Err(EventInvalid::EmptyActorChain);
        }
        if self.action.is_empty() {
            return Err(EventInvalid::EmptyAction);
        }
        if !is_dotted_lowercase_verb(&self.action) {
            return Err(EventInvalid::ActionNotADottedLowercaseVerb(
                self.action.clone(),
            ));
        }
        match &self.payload {
            serde_json::Value::Object(_) => {}
            serde_json::Value::Array(_) => return Err(EventInvalid::PayloadIsAnArray),
            serde_json::Value::Null => return Err(EventInvalid::PayloadIsNull),
            _ => return Err(EventInvalid::PayloadIsNotAnObject),
        }
        Ok(())
    }
}

/// Why an event cannot be appended.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EventInvalid {
    /// `actor_chain` was empty.
    #[error("actor_chain must not be empty")]
    EmptyActorChain,
    /// `action` was empty.
    #[error("action must not be empty")]
    EmptyAction,
    /// `action` was not a dotted lowercase verb.
    #[error("`{0}` is not a dotted lowercase verb")]
    ActionNotADottedLowercaseVerb(String),
    /// `payload` was an array.
    #[error("payload must be an object, not an array")]
    PayloadIsAnArray,
    /// `payload` was null.
    #[error("payload must be an object, not null")]
    PayloadIsNull,
    /// `payload` was a scalar.
    #[error("payload must be an object")]
    PayloadIsNotAnObject,
}

/// `action` is a dotted lowercase verb: `agent.token.issued`, not `Agent Token Issued`.
fn is_dotted_lowercase_verb(action: &str) -> bool {
    if action.is_empty() || action.starts_with('.') || action.ends_with('.') {
        return false;
    }
    action.split('.').all(|part| {
        !part.is_empty()
            && part
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    })
}

/// The three stored members §8.2 excludes from the canonical bytes.
///
/// Kept separate from [`AuditEvent`] so no code path can accidentally include them in the hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainFields {
    /// The row's `bigint` identity, 1-based and gapless within one org chain.
    pub seq: i64,
    /// The previous row's raw 32-byte digest.
    pub prev_hash: [u8; 32],
    /// This row's raw 32-byte digest.
    pub hash: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_event() -> AuditEvent {
        AuditEvent {
            id: EventId::new(),
            at: OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("timestamp"),
            action: "agent.token.issued".into(),
            actor_chain: vec![
                AuditActor::account(AccountId::new()),
                AuditActor::agent(AgentId::new()),
            ],
            subject: AuditSubject {
                subject_type: AuditActorType::Grant,
                id: Some(GrantId::new().to_typed_string()),
            },
            decision: AuditDecision::Allow,
            grant_id: Some(GrantId::new()),
            jti: Some(Uuid::now_v7()),
            payload: serde_json::json!({"scope": ["tools:read"]}),
        }
    }

    #[test]
    fn a_well_formed_event_validates() {
        valid_event().validate().expect("validates");
    }

    #[test]
    fn an_empty_actor_chain_is_invalid() {
        let mut event = valid_event();
        event.actor_chain.clear();
        assert_eq!(event.validate(), Err(EventInvalid::EmptyActorChain));
    }

    #[test]
    fn a_payload_that_is_not_an_object_is_invalid() {
        let mut event = valid_event();
        event.payload = serde_json::json!([1, 2]);
        assert_eq!(event.validate(), Err(EventInvalid::PayloadIsAnArray));

        event.payload = serde_json::Value::Null;
        assert_eq!(event.validate(), Err(EventInvalid::PayloadIsNull));

        event.payload = serde_json::json!("text");
        assert_eq!(event.validate(), Err(EventInvalid::PayloadIsNotAnObject));
    }

    #[test]
    fn an_action_that_is_not_a_dotted_lowercase_verb_is_invalid() {
        for action in [
            "Agent.Token.Issued",
            "agent token issued",
            ".agent",
            "agent.",
            "agent..x",
            "agent/issued",
        ] {
            let mut event = valid_event();
            event.action = action.into();
            assert!(
                matches!(
                    event.validate(),
                    Err(EventInvalid::ActionNotADottedLowercaseVerb(_))
                ),
                "`{action}` should be invalid"
            );
        }
        for action in [
            "tool.invoked",
            "interaction.sign_in.failed",
            "agent.token.issued",
        ] {
            let mut event = valid_event();
            event.action = action.into();
            assert!(event.validate().is_ok(), "`{action}` should be valid");
        }
    }

    /// The §8.1 example, round-tripped through serde.
    #[test]
    fn serializes_in_the_contract_shape() {
        let event = AuditEvent {
            id: EventId::from_uuid(
                Uuid::parse_str("00000000-0000-7000-8000-000000000000").expect("uuid"),
            ),
            at: OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("timestamp"),
            action: "agent.token.issued".into(),
            actor_chain: vec![
                AuditActor {
                    actor_type: AuditActorType::Account,
                    id: "acc_00000000000000000000000000".into(),
                },
                AuditActor {
                    actor_type: AuditActorType::Agent,
                    id: "agt_00000000000000000000000000".into(),
                },
            ],
            subject: AuditSubject {
                subject_type: AuditActorType::Grant,
                id: Some("grt_00000000000000000000000000".into()),
            },
            decision: AuditDecision::Allow,
            grant_id: None,
            jti: None,
            payload: serde_json::json!({"scope": ["tools:read"], "aud": "http://localhost:8080/mcp/demo"}),
        };

        let value = serde_json::to_value(&event).expect("serializes");
        assert_eq!(value["action"], "agent.token.issued");
        assert_eq!(value["decision"], "allow");
        assert_eq!(value["actor_chain"][0]["type"], "account");
        assert_eq!(value["subject"]["type"], "grant");
        // Chain fields must not appear: they are not members of this type at all.
        assert!(value.get("seq").is_none());
        assert!(value.get("prev_hash").is_none());
        assert!(value.get("hash").is_none());
        // Optional members are omitted, not null.
        assert!(value.get("grant_id").is_none());
        assert!(value.get("jti").is_none());
    }

    #[test]
    fn decision_strings_match_the_ddl_check_constraint() {
        assert_eq!(AuditDecision::Allow.as_str(), "allow");
        assert_eq!(AuditDecision::Deny.as_str(), "deny");
        assert_eq!(AuditDecision::Info.as_str(), "info");
    }
}
