//! The M0 scope decision — docs/contracts/m0.md §6.2 and §7.2.
//!
//! `scope_satisfies(granted, required)` is "every required scope is granted", never "any".
//! This is the same relation the token endpoint uses to reject an over-broad request with
//! `invalid_scope` and the same one `@monaca/mcp` uses to answer `403 insufficient_scope`, so
//! it must be identical on both sides of the FFI boundary.

use std::collections::HashSet;

/// A scope string that does not match the §6.2 grammar.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid scope `{scope}`: {reason}")]
pub struct InvalidScope {
    /// The rejected scope.
    pub scope: String,
    /// Why it was rejected.
    pub reason: &'static str,
}

/// Validate one scope against the §6.2 grammar:
/// `^[a-z][a-z0-9_.-]*(:[a-z][a-z0-9_.-]*)*$`.
///
/// Written as a scanner rather than a regex so this crate stays dependency-free; the grammar is
/// small enough that a regex would be more machinery than the rule it encodes.
pub fn is_valid_scope(scope: &str) -> Result<(), InvalidScope> {
    let reject = |reason: &'static str| {
        Err(InvalidScope { scope: scope.to_owned(), reason })
    };

    if scope.is_empty() {
        return reject("empty");
    }

    // Colon-separated components, each of which must itself be a valid component.
    for component in scope.split(':') {
        if component.is_empty() {
            return reject("empty component");
        }
        let mut chars = component.chars();
        let first = chars.next().expect("component is non-empty");
        if !first.is_ascii_lowercase() {
            return reject("component must start with a lowercase ASCII letter");
        }
        for ch in chars {
            // `[a-z0-9_.-]`
            let allowed = ch.is_ascii_lowercase()
                || ch.is_ascii_digit()
                || ch == '_'
                || ch == '.'
                || ch == '-';
            if !allowed {
                return reject("component may only contain [a-z0-9_.-] after the first character");
            }
        }
    }

    Ok(())
}

/// True when every entry of `required` is present in `granted`.
///
/// An empty `required` is satisfied by anything, including an empty `granted`: "nothing is
/// required" is a true statement about any grant. An empty `granted` satisfies only an empty
/// `required`. Duplicates on either side are irrelevant.
///
/// # Examples
///
/// ```
/// use monaca_policy::scope_satisfies;
///
/// assert!(scope_satisfies(&["tools:read".into()], &["tools:read".into()]));
/// assert!(!scope_satisfies(&["tools:read".into()], &["tools:write".into()]));
/// assert!(scope_satisfies(&["tools:read".into()], &[]));
/// ```
pub fn scope_satisfies(granted: &[String], required: &[String]) -> bool {
    if required.is_empty() {
        return true;
    }
    if granted.is_empty() {
        return false;
    }
    // Build the smaller set: for the usual case (a handful of scopes on each side) this is
    // irrelevant, but it keeps the function linear in the smaller input.
    let granted_set: HashSet<&str> = granted.iter().map(String::as_str).collect();
    required.iter().all(|scope| granted_set.contains(scope.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scopes(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn subset_is_satisfied() {
        assert!(scope_satisfies(&scopes(&["tools:read"]), &scopes(&["tools:read"])));
        assert!(scope_satisfies(
            &scopes(&["tools:read", "tools:write", "openid"]),
            &scopes(&["tools:read", "openid"])
        ));
    }

    #[test]
    fn missing_scope_is_not_satisfied() {
        assert!(!scope_satisfies(&scopes(&["tools:read"]), &scopes(&["tools:write"])));
        assert!(!scope_satisfies(
            &scopes(&["tools:read"]),
            &scopes(&["tools:read", "tools:write"])
        ));
    }

    #[test]
    fn nothing_required_is_always_satisfied() {
        assert!(scope_satisfies(&scopes(&[]), &scopes(&[])));
        assert!(scope_satisfies(&scopes(&["tools:read"]), &scopes(&[])));
    }

    #[test]
    fn nothing_granted_satisfies_only_nothing() {
        assert!(!scope_satisfies(&scopes(&[]), &scopes(&["tools:read"])));
        assert!(scope_satisfies(&scopes(&[]), &scopes(&[])));
    }

    #[test]
    fn duplicates_do_not_matter() {
        assert!(scope_satisfies(
            &scopes(&["tools:read", "tools:read"]),
            &scopes(&["tools:read", "tools:read"])
        ));
    }

    /// The decision is "all", never "any" — the property the delegation model depends on.
    #[test]
    fn is_all_not_any() {
        assert!(!scope_satisfies(
            &scopes(&["tools:read", "monaca:admin"]),
            &scopes(&["monaca:admin", "tools:write"])
        ));
    }

    #[test]
    fn comparison_is_exact_not_prefix_or_case_insensitive() {
        assert!(!scope_satisfies(&scopes(&["tools:read"]), &scopes(&["tools:"])));
        assert!(!scope_satisfies(&scopes(&["tools:read"]), &scopes(&["tools:read:"])));
        assert!(!scope_satisfies(&scopes(&["tools:read"]), &scopes(&["Tools:Read"])));
    }

    #[test]
    fn accepts_the_contract_grammar() {
        for scope in [
            "openid",
            "profile",
            "email",
            "offline_access",
            "tools:read",
            "tools:write",
            "monaca:admin",
            "a",
            "a1",
            "a_b",
            "a.b",
            "a-b",
            "a1:bc2_de.f-g",
        ] {
            assert!(is_valid_scope(scope).is_ok(), "`{scope}` should be valid");
        }
    }

    #[test]
    fn rejects_invalid_scopes() {
        for scope in [
            "",
            ":",
            ":read",
            "read:",
            "Read",
            "1read",
            "_read",
            "-read",
            ".read",
            "read write",
            "read/write",
            "read:Write",
            "read::write",
            "read+write",
            "tools:réad",
        ] {
            assert!(is_valid_scope(scope).is_err(), "`{scope}` should be invalid");
        }
    }

    #[test]
    fn invalid_scope_error_names_the_scope() {
        let err = is_valid_scope("Tools:Read").expect_err("must reject");
        assert_eq!(err.scope, "Tools:Read");
        assert!(err.to_string().contains("Tools:Read"));
    }

    #[test]
    fn decision_predicate() {
        assert!(Decision::Allow.is_allow());
        assert!(!Decision::Deny.is_allow());
    }
}
