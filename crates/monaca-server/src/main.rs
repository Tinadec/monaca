//! `monaca-server` — the axum 0.8 binary that fronts the whole system.
//!
//! Stage 0 implements the parts of the surface that do not need a database: the liveness and
//! version endpoints, the OpenAPI document, and the CLI's shape. `migrate` and `bootstrap`
//! report that they are not implemented yet and exit 0, so the CI e2e stage can call them
//! exactly as it will once they are real.
//!
//! Routes are split by the audiences in `docs/contracts/m0.md` §6:
//!
//! * the **protocol** endpoints under `/t/{tenant}` and `/.well-known`, reached through the
//!   gateway and issuing every `iss`;
//! * the **management** API under `/v1`, bearer-authenticated with `monaca:admin`;
//! * **`/internal/*`**, shared-secret authenticated, the only way the Bun side writes core data.
//!
//! M1 adds the real `/v1` handlers, OTLP export and mTLS on `/internal/*`.

mod cli;
mod openapi;
mod routes;

#[cfg(test)]
mod tests;

use std::net::SocketAddr;

use anyhow::Context as _;
use clap::Parser;

use crate::cli::{Cli, Command};

/// The default bind address — §2.2 `MONACA_SERVER_ADDR`.
pub const DEFAULT_ADDR: &str = "127.0.0.1:8081";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    cli::init_tracing(cli.log_level.as_deref(), cli.log_format.as_deref());

    match cli.command {
        Command::Serve(args) => serve(args).await,
        Command::Openapi(args) => openapi::run(args),
        Command::Migrate => {
            println!("not implemented in stage 0");
            Ok(())
        }
        Command::Bootstrap => {
            println!("not implemented in stage 0");
            Ok(())
        }
        Command::Audit(args) => match args.command {
            cli::AuditCommand::Verify => {
                println!("not implemented in stage 0");
                Ok(())
            }
        },
    }
}

/// Start the HTTP server on the configured address and serve until Ctrl-C.
async fn serve(args: cli::ServeArgs) -> anyhow::Result<()> {
    let addr = resolve_addr(args.addr.as_deref())?;
    let app = routes::router();

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("could not bind {addr}"))?;
    let bound = listener.local_addr().context("could not read the bound address")?;

    tracing::info!(%bound, "monaca-server listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("the server stopped with an error")
}

/// The bind address, from `--addr`, `MONACA_SERVER_ADDR`, or [`DEFAULT_ADDR`].
///
/// Parsed here rather than left to `TcpListener::bind` so a malformed address is a startup error
/// with a usable message, not a bind failure with a parse error inside it.
fn resolve_addr(explicit: Option<&str>) -> anyhow::Result<SocketAddr> {
    let raw = explicit
        .map(str::to_owned)
        .or_else(|| std::env::var("MONACA_SERVER_ADDR").ok())
        .unwrap_or_else(|| DEFAULT_ADDR.to_owned());

    raw.parse::<SocketAddr>()
        .with_context(|| format!("MONACA_SERVER_ADDR/--addr is not a socket address: `{raw}`"))
}

/// Resolve when the process should stop.
///
/// Ctrl-C on every platform, plus SIGTERM on Unix, so a container stop drains in-flight requests
/// instead of cutting them off.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::error!(%err, "could not listen for Ctrl-C");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => {
                tracing::error!(%err, "could not listen for SIGTERM");
                // Never resolve, so a broken signal handler cannot make the server exit early.
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    tracing::info!("shutdown signal received; draining");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_addr_matches_the_contract() {
        // §2.1: monaca-server is 8081 in dev, and it is never the public origin.
        assert_eq!(DEFAULT_ADDR, "127.0.0.1:8081");
    }

    #[test]
    fn an_explicit_addr_wins() {
        let addr = resolve_addr(Some("0.0.0.0:9999")).expect("parses");
        assert_eq!(addr.port(), 9999);
    }

    #[test]
    fn a_malformed_addr_is_a_startup_error() {
        let err = resolve_addr(Some("not-an-address")).expect_err("must fail");
        assert!(err.to_string().contains("not-an-address"));
    }
}
