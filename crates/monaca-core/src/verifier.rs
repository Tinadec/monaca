//! The ES256 access-token verifier — docs/contracts/m0.md §4.2, §4.3 and §7.
//!
//! The flow is: decode the header without trusting it, select the key by `kid`, verify the
//! signature with that key, and only then read the claims. Doing the signature first is what
//! makes every later check trustworthy; a claim checked before the signature is a claim an
//! attacker chose.
//!
//! Time is read from an injected [`Clock`], so a test can pin "now" instead of sleeping.

use jsonwebtoken::{Algorithm, Validation};
use monaca_types::{Clock, SystemClock};

use crate::claims::{AccessTokenClaims, VerifiedToken};
use crate::error::{ErrorCode, TokenError};
use crate::jwks::{IssuerKeys, KeySet};
use crate::DEFAULT_CLOCK_SKEW_SECS;

/// Construction options — §4.2 `VerifierOptions`.
#[derive(Debug, Clone)]
pub struct VerifierOptions {
    /// Permitted clock skew in seconds. Defaults to [`DEFAULT_CLOCK_SKEW_SECS`].
    pub clock_skew_secs: u64,
}

impl Default for VerifierOptions {
    fn default() -> Self {
        Self { clock_skew_secs: DEFAULT_CLOCK_SKEW_SECS }
    }
}

impl VerifierOptions {
    /// Options with the contract default skew.
    pub fn new() -> Self {
        Self::default()
    }

    /// Options with an explicit skew.
    pub fn with_clock_skew_secs(secs: u64) -> Self {
        Self { clock_skew_secs: secs }
    }
}

/// The in-process verifier.
///
/// Holds one key set per issuer and the clock used for the time checks. No I/O happens here, so
/// this type is safe to construct inside a napi callback and needs no runtime.
pub struct Verifier {
    keys: KeySet,
    clock: Box<dyn Clock>,
    options: VerifierOptions,
}

impl std::fmt::Debug for Verifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Verifier")
            .field("issuers", &self.keys.len())
            .field("clock_skew_secs", &self.options.clock_skew_secs)
            .finish_non_exhaustive()
    }
}

impl Default for Verifier {
    fn default() -> Self {
        Self::new(VerifierOptions::default())
    }
}

impl Verifier {
    /// A verifier with no keys and the system clock.
    pub fn new(options: VerifierOptions) -> Self {
        Self {
            keys: KeySet::new(),
            clock: Box::new(SystemClock),
            options,
        }
    }

    /// A verifier reading time from `clock`. Tests use this; production does not.
    pub fn with_clock(options: VerifierOptions, clock: Box<dyn Clock>) -> Self {
        Self { keys: KeySet::new(), clock, options }
    }

    /// Replace the key set for `issuer` — §4.2 `setKeys`.
    ///
    /// The whole document replaces the previous one for that issuer, so a retired key stops
    /// verifying as soon as the caller refreshes.
    pub fn set_keys(&mut self, issuer: &str, jwks_json: &str) -> Result<(), TokenError> {
        self.keys.insert_jwks(issuer, jwks_json)
    }

    /// The keys loaded for `issuer`.
    pub fn issuer_keys(&self, issuer: &str) -> Option<&IssuerKeys> {
        self.keys.issuer(issuer)
    }

    /// How many issuers have keys loaded.
    pub fn issuer_count(&self) -> usize {
        self.keys.len()
    }

    /// The clock skew in use.
    pub fn clock_skew_secs(&self) -> u64 {
        self.options.clock_skew_secs
    }

    /// Verify an access token — §4.2 `verifyAccessToken`.
    ///
    /// `expected_issuer` must equal the token's `iss`, and `expected_audience` must be named by
    /// the token's `aud` (a string, or any entry of an array).
    pub fn verify_access_token(
        &self,
        token: &str,
        expected_issuer: &str,
        expected_audience: &str,
    ) -> Result<VerifiedToken, TokenError> {
        // 1. Decode the header without verifying, only to learn which key to use. Nothing read
        //    here is trusted beyond selecting a key, and the key selection itself is what
        //    `kid` is for — an unknown `kid` cannot be used to bypass anything, it just fails.
        let header = jsonwebtoken::decode_header(token)
            .map_err(|err| malformed_from_jsonwebtoken(&err, "header"))?;

        if header.alg != Algorithm::ES256 {
            // §7: every token is `alg = ES256`. Accepting another algorithm here would be an
            // algorithm-confusion hole, so this is a signature failure, not a claims failure.
            return Err(TokenError::new(
                ErrorCode::InvalidSignature,
                format!("unexpected alg `{:?}`; only ES256 is accepted", header.alg),
            ));
        }

        let kid = header.kid.as_deref().filter(|kid| !kid.is_empty()).ok_or_else(|| {
            TokenError::new(ErrorCode::UnknownKid, "token header has no `kid`")
        })?;

        let keys = self.keys.issuer(expected_issuer).ok_or_else(|| {
            TokenError::new(
                ErrorCode::UnknownKid,
                format!("no keys loaded for issuer `{expected_issuer}`"),
            )
        })?;

        let decoding_key = keys.get(kid).ok_or_else(|| {
            TokenError::new(
                ErrorCode::UnknownKid,
                format!("kid `{kid}` is not in the loaded key set for `{expected_issuer}`"),
            )
        })?;

        // 2. Verify the signature. `Validation` is configured for the time and issuer checks
        //    jsonwebtoken does itself; `aud` is validated here rather than by jsonwebtoken
        //    because §6.2 wants an exact comparison against one audience, and because the
        //    audience check must be able to report its own code.
        let validation = self.validation_for(expected_issuer);
        let token_data = jsonwebtoken::decode::<AccessTokenClaims>(token, decoding_key, &validation)
            .map_err(|err| self.classify_decode_error(&err, expected_issuer))?;

        let claims = token_data.claims;

        // 3. Signature is good; now the claims can be trusted enough to check the rest.
        let audience = claims
            .aud
            .as_ref()
            .ok_or_else(|| missing_claim("aud"))?;
        if !audience.contains(expected_audience) {
            return Err(TokenError::new(
                ErrorCode::AudienceMismatch,
                format!(
                    "token audience `{}` does not include `{expected_audience}`",
                    audience.to_reported_string()
                ),
            ));
        }

        // `iss` is also checked by `Validation`, but re-checking here means a mis-set validation
        // can never silently skip it.
        let iss = claims.iss.as_deref().ok_or_else(|| missing_claim("iss"))?;
        if iss != expected_issuer {
            return Err(TokenError::new(
                ErrorCode::IssuerMismatch,
                format!("token issuer `{iss}` is not `{expected_issuer}`"),
            ));
        }

        let sub = claims.sub.ok_or_else(|| missing_claim("sub"))?;
        let tid = claims.tid.ok_or_else(|| missing_claim("tid"))?;
        let org = claims.org.ok_or_else(|| missing_claim("org"))?;
        let jti = claims.jti.ok_or_else(|| missing_claim("jti"))?;
        let iat = claims.iat.ok_or_else(|| missing_claim("iat"))?;
        let exp = claims.exp.ok_or_else(|| missing_claim("exp"))?;
        let scope = claims.scope.as_ref().map(|scope| scope.normalized()).unwrap_or_default();

        // §4.3: `iat` implausibly ahead of now is MONACA_TOKEN_NOT_YET_VALID. jsonwebtoken
        // validates `nbf` but has no `iat` check, and a future `iat` is how a stolen token gets
        // an extended life on a verifier whose clock is behind, so it is checked here.
        self.check_iat(iat)?;

        Ok(VerifiedToken {
            iss: iss.to_owned(),
            sub,
            aud: audience.to_reported_string(),
            tid,
            org,
            scope,
            act: claims.act,
            grant_id: claims.grant_id,
            jti,
            iat,
            exp,
        })
    }

    /// Reject an `iat` that is implausibly ahead of this verifier's clock — §4.3.
    ///
    /// The tolerance is the configured skew, so a token minted by a server whose clock runs
    /// slightly fast still verifies, while one minted far in the future does not.
    fn check_iat(&self, iat: i64) -> Result<(), TokenError> {
        let now = self.clock.now().unix_timestamp();
        let skew = i64::try_from(self.options.clock_skew_secs).unwrap_or(i64::MAX);
        // `saturating_add` so an absurd `iat` cannot wrap into the past and pass.
        let limit = now.saturating_add(skew);
        if iat > limit {
            return Err(TokenError::new(
                ErrorCode::NotYetValid,
                format!("token `iat` ({iat}) is more than {skew}s ahead of now ({now})"),
            ));
        }
        Ok(())
    }

    /// The `Validation` handed to jsonwebtoken.
    fn validation_for(&self, expected_issuer: &str) -> Validation {
        let mut validation = Validation::new(Algorithm::ES256);
        validation.leeway = self.options.clock_skew_secs;
        validation.validate_exp = true;
        validation.validate_nbf = true;
        // `aud` is checked above so that a mismatch reports MONACA_TOKEN_AUDIENCE_MISMATCH with
        // the audience named; letting jsonwebtoken do it too would only turn a good error into a
        // worse one.
        validation.validate_aud = false;
        validation.set_issuer(&[expected_issuer]);
        // `exp` is the only claim jsonwebtoken requires by default; the rest are checked above
        // so each can name itself in the error.
        validation.set_required_spec_claims(&["exp"]);
        validation
    }

    /// Map a jsonwebtoken decode error onto a contract code.
    fn classify_decode_error(
        &self,
        err: &jsonwebtoken::errors::Error,
        expected_issuer: &str,
    ) -> TokenError {
        use jsonwebtoken::errors::ErrorKind as Kind;

        match err.kind() {
            Kind::ExpiredSignature => {
                TokenError::new(ErrorCode::Expired, "token has expired")
            }
            Kind::ImmatureSignature => TokenError::new(
                ErrorCode::NotYetValid,
                format!("token `nbf` is in the future (skew {}s)", self.options.clock_skew_secs),
            ),
            Kind::InvalidIssuer => TokenError::new(
                ErrorCode::IssuerMismatch,
                format!("token issuer is not `{expected_issuer}`"),
            ),
            Kind::InvalidAudience => {
                TokenError::new(ErrorCode::AudienceMismatch, "token audience does not match")
            }
            Kind::MissingRequiredClaim(claim) => missing_claim(claim),
            Kind::InvalidClaimFormat(claim) => TokenError::new(
                ErrorCode::ClaimsInvalid,
                format!("claim `{claim}` has the wrong type"),
            ),
            Kind::InvalidSignature => {
                TokenError::new(ErrorCode::InvalidSignature, "signature does not verify")
            }
            Kind::InvalidAlgorithm | Kind::MissingAlgorithm => TokenError::new(
                ErrorCode::InvalidSignature,
                "token algorithm is not the expected ES256",
            ),
            Kind::InvalidToken | Kind::Base64(_) | Kind::Utf8(_) => {
                malformed_from_jsonwebtoken(err, "token")
            }
            Kind::Json(inner) => TokenError::new(
                ErrorCode::ClaimsInvalid,
                format!("claims are not a valid JSON object: {inner}"),
            ),
            // An unusable key is a key-set problem, not a token problem: the token may be
            // perfectly good and the JWKS wrong.
            Kind::InvalidEcdsaKey | Kind::InvalidKeyFormat => TokenError::new(
                ErrorCode::JwksInvalid,
                format!("loaded key cannot verify ES256: {err}"),
            ),
            other => {
                // `ErrorKind` is #[non_exhaustive]; a variant this build does not know is
                // reported as malformed rather than guessed at.
                TokenError::new(
                    ErrorCode::Malformed,
                    format!("token could not be decoded: {other:?}"),
                )
            }
        }
    }
}

fn missing_claim(claim: &str) -> TokenError {
    TokenError::new(ErrorCode::ClaimsInvalid, format!("required claim `{claim}` is missing"))
}

/// A decode failure in the header or the JWS envelope is `MONACA_TOKEN_MALFORMED` — §4.3's
/// "not a JWS, bad JSON, bad base64url, wrong segment count".
fn malformed_from_jsonwebtoken(err: &jsonwebtoken::errors::Error, what: &str) -> TokenError {
    TokenError::new(ErrorCode::Malformed, format!("{what} could not be decoded: {err}"))
}
