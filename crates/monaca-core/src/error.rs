//! The typed errors that cross the napi boundary — docs/contracts/m0.md §4.3.
//!
//! Each variant maps to exactly one `MONACA_*` string. That string is both the JS `Error.code`
//! and the prefix of the JS error message, so a caller can branch on the code and still read a
//! useful message when it does not.

/// The stable error code carried across the FFI boundary.
///
/// The set is closed on purpose: `@monaca/mcp` and the gateway branch on these strings, so
/// adding a variant means updating `packages/core/index.d.ts` and its consumers together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// Not a JWS, bad JSON, bad base64url, or the wrong number of segments.
    Malformed,
    /// The token's `kid` is not in the loaded key set.
    UnknownKid,
    /// The signature does not verify against the key named by `kid`.
    InvalidSignature,
    /// `exp` plus skew is in the past.
    Expired,
    /// `nbf` minus skew is in the future, or `iat` is implausibly ahead.
    NotYetValid,
    /// `iss` is not the expected issuer.
    IssuerMismatch,
    /// Neither the `aud` string nor any `aud` array entry equals the expected audience.
    AudienceMismatch,
    /// A required claim is missing or has the wrong type.
    ClaimsInvalid,
    /// The JWKS is unparseable or holds no usable ES256 key.
    JwksInvalid,
}

impl ErrorCode {
    /// The exact `MONACA_*` string for this code.
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Malformed => "MONACA_TOKEN_MALFORMED",
            ErrorCode::UnknownKid => "MONACA_TOKEN_UNKNOWN_KID",
            ErrorCode::InvalidSignature => "MONACA_TOKEN_INVALID_SIGNATURE",
            ErrorCode::Expired => "MONACA_TOKEN_EXPIRED",
            ErrorCode::NotYetValid => "MONACA_TOKEN_NOT_YET_VALID",
            ErrorCode::IssuerMismatch => "MONACA_TOKEN_ISSUER_MISMATCH",
            ErrorCode::AudienceMismatch => "MONACA_TOKEN_AUDIENCE_MISMATCH",
            ErrorCode::ClaimsInvalid => "MONACA_TOKEN_CLAIMS_INVALID",
            ErrorCode::JwksInvalid => "MONACA_JWKS_INVALID",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A verification failure, carrying its contract code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {detail}")]
pub struct TokenError {
    /// The contract code.
    pub code: ErrorCode,
    /// Occurrence-specific explanation, appended to the code in the message.
    pub detail: String,
}

impl TokenError {
    /// Build an error from a code and a detail.
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }

    /// The `MONACA_*` string.
    pub const fn code(&self) -> &'static str {
        self.code.as_str()
    }

    /// The message the JS `Error` carries: the code, then the detail.
    ///
    /// §4.3 requires the message to be prefixed with the code, so this is the single place that
    /// formats it and both the napi layer and the Rust tests use it.
    pub fn message(&self) -> String {
        format!("{}: {}", self.code.as_str(), self.detail)
    }
}

impl From<ErrorCode> for TokenError {
    fn from(code: ErrorCode) -> Self {
        Self::new(code, "")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every §4.3 code, spelled out — a typo here is a client-visible contract break.
    #[test]
    fn codes_match_the_contract_table() {
        assert_eq!(ErrorCode::Malformed.as_str(), "MONACA_TOKEN_MALFORMED");
        assert_eq!(ErrorCode::UnknownKid.as_str(), "MONACA_TOKEN_UNKNOWN_KID");
        assert_eq!(ErrorCode::InvalidSignature.as_str(), "MONACA_TOKEN_INVALID_SIGNATURE");
        assert_eq!(ErrorCode::Expired.as_str(), "MONACA_TOKEN_EXPIRED");
        assert_eq!(ErrorCode::NotYetValid.as_str(), "MONACA_TOKEN_NOT_YET_VALID");
        assert_eq!(ErrorCode::IssuerMismatch.as_str(), "MONACA_TOKEN_ISSUER_MISMATCH");
        assert_eq!(ErrorCode::AudienceMismatch.as_str(), "MONACA_TOKEN_AUDIENCE_MISMATCH");
        assert_eq!(ErrorCode::ClaimsInvalid.as_str(), "MONACA_TOKEN_CLAIMS_INVALID");
        assert_eq!(ErrorCode::JwksInvalid.as_str(), "MONACA_JWKS_INVALID");
    }

    #[test]
    fn message_is_prefixed_with_the_code() {
        let error = TokenError::new(ErrorCode::Expired, "token expired at 2026-01-01T00:00:00Z");
        assert_eq!(
            error.message(),
            "MONACA_TOKEN_EXPIRED: token expired at 2026-01-01T00:00:00Z"
        );
        assert!(error.message().starts_with(error.code()));
    }

    #[test]
    fn display_matches_message() {
        let error = TokenError::new(ErrorCode::UnknownKid, "kid `abc`");
        assert_eq!(error.to_string(), error.message());
    }

    #[test]
    fn from_code_has_no_detail() {
        let error = TokenError::from(ErrorCode::Malformed);
        assert_eq!(error.message(), "MONACA_TOKEN_MALFORMED: ");
    }
}
