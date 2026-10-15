# Notes for the VPS that runs mode B (docs/contracts/m0.md §3, §10.4).
#
# Nothing in this directory is a secret. The real `deploy/.env` is written on the host by
# .github/workflows/deploy-dev.yml from the DEPLOY_ENV_FILE secret, mode 0600, and is never
# committed (`.gitignore` covers `.env` and `.env.*`).
#
# The host needs: docker with the compose plugin, and a login that can run it. No Rust, no
# Node, no PostgreSQL — all three live inside the containers.

## First-time setup

    ssh <user>@<host>
    mkdir -p /opt/monaca && cd /opt/monaca
    # compose.dev.yml, remote-deploy.sh and .env are copied by deploy-dev.yml; to bootstrap by
    # hand, copy the two files and write .env yourself:
    scp deploy/compose.dev.yml deploy/remote-deploy.sh <user>@<host>:/opt/monaca/

Then set these repository secrets (Settings → Secrets and variables → Actions):

| secret | required | meaning |
|---|---|---|
| `DEPLOY_HOST` | yes | hostname or IP of the VPS |
| `DEPLOY_USER` | yes | ssh user |
| `DEPLOY_SSH_KEY` | yes | private key for that user (its public half in `~/.ssh/authorized_keys`) |
| `DEPLOY_PORT` | no | ssh port, default 22 |
| `DEPLOY_PATH` | no | directory holding the compose file, default `/opt/monaca` |
| `DEPLOY_ENV_FILE` | no | contents of the deployed `.env` (see below) |

With the three required secrets unset, `deploy-dev.yml` exits 0 having done nothing. That is
the intended behaviour: a contributor who only runs the Vue apps (mode B without a deploy
target) should never see a red workflow.

## The deployed `.env`

`compose.dev.yml` reads it via `--env-file`. It must define at least:

    MONACA_PUBLIC_BASE_URL=https://dev.monaca.example
    POSTGRES_PASSWORD=<generated>
    MONACA_INTERNAL_SECRET=<generated>
    MONACA_DEV_KEK=<64 hex chars>
    MONACA_APP_DB_PASSWORD=<generated>
    MONACA_BOOTSTRAP_ADMIN_PASSWORD=<generated>
    MONACA_BOOTSTRAP_ADMIN_CLIENT_SECRET=<generated>
    MONACA_CONSOLE_CLIENT_SECRET=<generated>

Compose fails with an explicit "set POSTGRES_PASSWORD in deploy/.env" message when a required
value is missing, rather than starting a stack with a default credential.

`MONACA_DEV_KEK` is dev-only and the server refuses it unless `MONACA_ENV=dev` (§2.2) — which
is exactly what the compose file sets. A real environment uses the KMS KeyProvider instead.

## Operating

`remote-deploy.sh` is the deploy itself (postgres ready → pull → migrate → bootstrap → up);
run it by hand on the host when a workflow deploy fails:

    cd /opt/monaca
    MONACA_SERVER_IMAGE=ghcr.io/<owner>/monaca-server:<sha> \
    MONACA_GATEWAY_IMAGE=ghcr.io/<owner>/monaca-gateway:<sha> \
      bash remote-deploy.sh

    docker compose -f compose.dev.yml --env-file .env ps
    docker compose -f compose.dev.yml --env-file .env logs -f gateway

`migrate` and `bootstrap` are one-shot services: `remote-deploy.sh` runs them explicitly
before `up`, and `bootstrap` runs once per deploy (it is idempotent by contract, §5.6). A
server restart therefore never re-provisions.

The gateway publishes `${MONACA_GATEWAY_PORT:-8080}` and is the single public origin. The
server is not published at all: reach it only through the gateway, which is what makes
`MONACA_PUBLIC_BASE_URL` the sole source of every `iss` (§2.1).

TLS is terminated by whatever fronts the host (Caddy, nginx, a cloud load balancer) — that
front end is what turns `MONACA_PUBLIC_BASE_URL` into an `https://` origin, and the gateway
itself speaks plain HTTP inside the network.
