//! The OpenID Connect and OAuth 2.1 protocol engine: discovery, JWKS, authorize, interaction,
//! token and id_token.
//!
//! **Stage 0 is a stub.** The types below fix the shape the rest of the workspace will build
//! against; the implementations land with the M0 feature work (plan §10 step 4, "OIDC 最小集").
//!
//! The split this crate encodes is the one that makes the auth-ui possible at all: the protocol
//! engine owns the flow, and the UI only ever sees an [`InteractionApi`] handle. That is the
//! Hydra-style login/consent challenge pattern — `authorize` stores an interaction and 302s to
//! the hosted sign-in page with `int_…`, and the page calls back into the interaction API. The
//! interaction id is the bearer of the request, which is why it is high-entropy and single-use.
//!
//! M0 roadmap:
//! 1. `DiscoveryDocument` — one document, served byte-identically at both path forms (§6.1).
//! 2. `Jwks` — `/t/{tenant}/.well-known/jwks.json`, served verbatim from `signing_keys.public_jwk`.
//! 3. `AuthorizeRequest` — validation, then interaction creation.
//! 4. `InteractionApi` — details, sign-in, abort.
//! 5. `TokenRequest` — `authorization_code` (PKCE S256 mandatory), `refresh_token` and
//!    `client_credentials`, with `private_key_jwt` client authentication and RFC 9396
//!    `authorization_details`.
//! 6. `IdTokenBuilder`.
//!
//! M1 adds PAR, DPoP, introspection, revocation, nonce enforcement and `at_hash`.

/// The OAuth 2.0 / RFC 6749 §5.2 token-endpoint error codes.
///
/// These are the one place the API is **not** RFC 9457: §6.1 requires the token endpoint to
/// answer with the flat `{"error": …, "error_description": …}` shape, because clients implement
/// that shape and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenErrorCode {
    /// The request is missing a parameter or is otherwise malformed.
    InvalidRequest,
    /// Client authentication failed. Answered with 401 and `WWW-Authenticate: Basic realm="monaca"`.
    InvalidClient,
    /// The grant or refresh token is invalid, expired or revoked.
    InvalidGrant,
    /// The client is not allowed to use this grant type.
    UnauthorizedClient,
    /// The grant type is not supported.
    UnsupportedGrantType,
    /// The requested scope exceeds what the grant allows.
    InvalidScope,
}

impl TokenErrorCode {
    /// The wire string.
    pub const fn as_str(self) -> &'static str {
        match self {
            TokenErrorCode::InvalidRequest => "invalid_request",
            TokenErrorCode::InvalidClient => "invalid_client",
            TokenErrorCode::InvalidGrant => "invalid_grant",
            TokenErrorCode::UnauthorizedClient => "unauthorized_client",
            TokenErrorCode::UnsupportedGrantType => "unsupported_grant_type",
            TokenErrorCode::InvalidScope => "invalid_scope",
        }
    }

    /// The HTTP status §6.1 requires for this code.
    pub const fn status(self) -> u16 {
        match self {
            TokenErrorCode::InvalidClient => 401,
            _ => 400,
        }
    }
}

/// The grant types the token endpoint accepts — §6.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantType {
    /// `authorization_code`, with mandatory PKCE S256.
    AuthorizationCode,
    /// `refresh_token`.
    RefreshToken,
    /// `client_credentials`, with RFC 8707 `resource` and RFC 9396 `authorization_details`.
    ClientCredentials,
}

impl GrantType {
    /// The wire string.
    pub const fn as_str(self) -> &'static str {
        match self {
            GrantType::AuthorizationCode => "authorization_code",
            GrantType::RefreshToken => "refresh_token",
            GrantType::ClientCredentials => "client_credentials",
        }
    }

    /// Parse a `grant_type` parameter.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "authorization_code" => Some(GrantType::AuthorizationCode),
            "refresh_token" => Some(GrantType::RefreshToken),
            "client_credentials" => Some(GrantType::ClientCredentials),
            _ => None,
        }
    }
}

/// The interaction a `authorize` request creates, as the auth-ui reads it — §6.1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interaction {
    /// The interaction id, `int_…`. This is the bearer of the request.
    pub interaction_id: String,
    /// The tenant slug the interaction belongs to.
    pub tenant: String,
    /// The client the authorize request named.
    pub client_id: String,
    /// The scopes the authorize request asked for.
    pub scopes: Vec<String>,
    /// The organization slug the flow will issue into.
    pub organization: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_error_codes_match_rfc_6749() {
        assert_eq!(TokenErrorCode::InvalidRequest.as_str(), "invalid_request");
        assert_eq!(TokenErrorCode::InvalidClient.as_str(), "invalid_client");
        assert_eq!(TokenErrorCode::InvalidGrant.as_str(), "invalid_grant");
        assert_eq!(TokenErrorCode::UnauthorizedClient.as_str(), "unauthorized_client");
        assert_eq!(TokenErrorCode::UnsupportedGrantType.as_str(), "unsupported_grant_type");
        assert_eq!(TokenErrorCode::InvalidScope.as_str(), "invalid_scope");
    }

    /// §6.1: "status 400 (401 for `invalid_client`)".
    #[test]
    fn only_invalid_client_is_a_401() {
        assert_eq!(TokenErrorCode::InvalidClient.status(), 401);
        for code in [
            TokenErrorCode::InvalidRequest,
            TokenErrorCode::InvalidGrant,
            TokenErrorCode::UnauthorizedClient,
            TokenErrorCode::UnsupportedGrantType,
            TokenErrorCode::InvalidScope,
        ] {
            assert_eq!(code.status(), 400, "{code:?} must be 400");
        }
    }

    #[test]
    fn grant_types_round_trip() {
        for grant in [GrantType::AuthorizationCode, GrantType::RefreshToken, GrantType::ClientCredentials]
        {
            assert_eq!(GrantType::parse(grant.as_str()), Some(grant));
        }
        assert_eq!(GrantType::parse("password"), None);
        assert_eq!(GrantType::parse(""), None);
    }

    /// §6.1's discovery document lists exactly these three grant types.
    #[test]
    fn the_discovery_grant_types_are_covered() {
        for name in ["authorization_code", "refresh_token", "client_credentials"] {
            assert!(GrantType::parse(name).is_some(), "{name} must be supported");
        }
    }
}
