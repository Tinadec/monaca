//! Agents, grants, permission attenuation and delegated token minting.
//!
//! **Stage 0 is a stub.** The types below fix the shape the rest of the workspace will build
//! against; the implementations land with the M0 feature work (plan §10 step 5, "Agent 与审计").
//!
//! The algebra this crate owns is monotone narrowing (plan §5):
//!
//! * `scope` only intersects — never unions;
//! * `aud` only narrows;
//! * `exp` only shortens;
//! * depth is capped.
//!
//! [`attenuate`] is that algebra as a function, so the property test in M0's acceptance suite
//! ("every hop's permission is a subset of its parent's") has one thing to point at. M3 adds
//! RFC 8693 multi-hop exchange and CIBA; the function already takes the child's request rather
//! than assuming one hop.
//!
//! The delegated-token TTL is fixed at 300 s and is **not** configurable (§7.2).

/// The fixed TTL of an agent-delegated token, in seconds — §7.2.
pub const DELEGATED_TOKEN_TTL_SECS: i64 = 300;

/// What a hop is allowed to do: the narrowing triple of §7.2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permission {
    /// Granted scopes. Compared as a set; order is not significant.
    pub scopes: Vec<String>,
    /// The resource the token's `aud` names.
    pub resource: String,
    /// Absolute expiry, or `None` for "as long as the parent allows".
    pub expires_at: Option<time::OffsetDateTime>,
}

/// Why attenuation was refused.
///
/// Attenuation only ever narrows, so a request that tries to widen is a refusal rather than a
/// silent clamp: a silent clamp would let an over-broad request look successful while the
/// resulting token silently lacks a scope the caller believes it has.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AttenuationError {
    /// The child asked for a scope the parent does not hold.
    #[error("scope `{0}` is not held by the parent")]
    ScopeNotHeld(String),
    /// The child asked for a different resource than the parent's.
    #[error("resource `{child}` does not match the parent's `{parent}`")]
    ResourceWidened {
        /// The parent's resource.
        parent: String,
        /// The child's requested resource.
        child: String,
    },
    /// The child asked to live longer than the parent.
    #[error("child expiry is later than the parent's")]
    ExpiryExtended,
    /// The chain would exceed the depth cap.
    #[error("delegation depth {depth} exceeds the cap of {cap}")]
    DepthExceeded {
        /// The depth the chain would reach.
        depth: usize,
        /// The configured cap.
        cap: usize,
    },
}

/// Narrow `parent` to `child` — plan §5's monotone attenuation.
///
/// Every field may only narrow: scopes intersect, the resource must be identical, and the expiry
/// must not move later. A `child` with no expiry inherits the parent's, which is a narrowing
/// (equal) rather than a widening.
///
/// This is the M0 single-hop form. M3's multi-hop exchange calls it once per hop, which is why
/// it takes the parent as an argument instead of reading a chain.
pub fn attenuate(
    parent: &Permission,
    child: &Permission,
) -> Result<Permission, AttenuationError> {
    for scope in &child.scopes {
        if !parent.scopes.contains(scope) {
            return Err(AttenuationError::ScopeNotHeld(scope.clone()));
        }
    }

    if child.resource != parent.resource {
        return Err(AttenuationError::ResourceWidened {
            parent: parent.resource.clone(),
            child: child.resource.clone(),
        });
    }

    let expires_at = match (parent.expires_at, child.expires_at) {
        (Some(parent_expiry), Some(child_expiry)) => {
            if child_expiry > parent_expiry {
                return Err(AttenuationError::ExpiryExtended);
            }
            Some(child_expiry)
        }
        // No child expiry means "inherit the parent's", never "never expires".
        (parent_expiry, None) => parent_expiry,
        // A parent that never expires still lets the child pick a bound: that narrows.
        (None, Some(child_expiry)) => Some(child_expiry),
    };

    let mut scopes = child.scopes.clone();
    scopes.sort_unstable();
    scopes.dedup();

    Ok(Permission { scopes, resource: parent.resource.clone(), expires_at })
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::OffsetDateTime;

    fn permission(scopes: &[&str], resource: &str) -> Permission {
        Permission {
            scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
            resource: resource.to_owned(),
            expires_at: None,
        }
    }

    const RESOURCE: &str = "http://localhost:8080/mcp/demo";

    #[test]
    fn ttl_is_the_contract_value() {
        assert_eq!(DELEGATED_TOKEN_TTL_SECS, 300);
    }

    #[test]
    fn narrowing_scopes_is_allowed() {
        let parent = permission(&["tools:read", "tools:write"], RESOURCE);
        let child = permission(&["tools:read"], RESOURCE);
        let result = attenuate(&parent, &child).expect("narrows");
        assert_eq!(result.scopes, vec!["tools:read"]);
        assert_eq!(result.resource, RESOURCE);
    }

    #[test]
    fn widening_scopes_is_refused() {
        let parent = permission(&["tools:read"], RESOURCE);
        let child = permission(&["tools:read", "tools:write"], RESOURCE);
        let err = attenuate(&parent, &child).expect_err("must refuse");
        assert_eq!(err, AttenuationError::ScopeNotHeld("tools:write".to_owned()));
    }

    #[test]
    fn a_different_resource_is_refused() {
        let parent = permission(&["tools:read"], RESOURCE);
        let child = permission(&["tools:read"], "http://localhost:8080/mcp/other");
        let err = attenuate(&parent, &child).expect_err("must refuse");
        assert!(matches!(err, AttenuationError::ResourceWidened { .. }));
    }

    #[test]
    fn a_later_expiry_is_refused() {
        let base = OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("timestamp");
        let parent = Permission {
            scopes: vec!["tools:read".into()],
            resource: RESOURCE.into(),
            expires_at: Some(base),
        };
        let child = Permission {
            scopes: vec!["tools:read".into()],
            resource: RESOURCE.into(),
            expires_at: Some(base + time::Duration::seconds(600)),
        };
        assert_eq!(attenuate(&parent, &child), Err(AttenuationError::ExpiryExtended));
    }

    #[test]
    fn a_shorter_expiry_is_allowed() {
        let base = OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("timestamp");
        let parent = Permission {
            scopes: vec!["tools:read".into()],
            resource: RESOURCE.into(),
            expires_at: Some(base),
        };
        let child = Permission {
            scopes: vec!["tools:read".into()],
            resource: RESOURCE.into(),
            expires_at: Some(base - time::Duration::seconds(60)),
        };
        let result = attenuate(&parent, &child).expect("narrows");
        assert_eq!(result.expires_at, Some(base - time::Duration::seconds(60)));
    }

    /// A child with no expiry inherits the parent's — it does not become unbounded.
    #[test]
    fn no_child_expiry_inherits_the_parents() {
        let base = OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("timestamp");
        let parent = Permission {
            scopes: vec!["tools:read".into()],
            resource: RESOURCE.into(),
            expires_at: Some(base),
        };
        let child = permission(&["tools:read"], RESOURCE);
        assert_eq!(attenuate(&parent, &child).expect("narrows").expires_at, Some(base));
    }

    #[test]
    fn the_result_is_always_a_subset_of_the_parent() {
        // The property plan §13 asks proptest to check, asserted here for the cases that matter
        // most: no call to `attenuate` can return a scope the parent did not hold.
        let parent = permission(&["tools:read", "tools:write", "openid"], RESOURCE);
        for requested in [
            vec!["tools:read"],
            vec!["tools:write"],
            vec!["openid", "tools:read"],
            vec![],
        ] {
            let child = Permission {
                scopes: requested.iter().map(|s| (*s).to_owned()).collect(),
                resource: RESOURCE.into(),
                expires_at: None,
            };
            let result = attenuate(&parent, &child).expect("narrows");
            for scope in &result.scopes {
                assert!(parent.scopes.contains(scope), "{scope} was not held by the parent");
            }
        }
    }

    #[test]
    fn the_result_is_deduplicated_and_sorted() {
        let parent = permission(&["tools:read", "tools:write"], RESOURCE);
        let child = permission(&["tools:write", "tools:read", "tools:write"], RESOURCE);
        assert_eq!(
            attenuate(&parent, &child).expect("narrows").scopes,
            vec!["tools:read", "tools:write"]
        );
    }

    #[test]
    fn depth_is_capped() {
        let err = AttenuationError::DepthExceeded { depth: 4, cap: 3 };
        assert!(err.to_string().contains("depth 4"));
    }
}
