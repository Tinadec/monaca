#!/usr/bin/env bash
#
# Runs ON the deploy host (docs/contracts/m0.md §10.4). deploy-dev.yml copies this file and
# compose.dev.yml to $DEPLOY_PATH and then runs:
#
#   MONACA_SERVER_IMAGE=ghcr.io/<owner>/monaca-server:<sha> \
#   MONACA_GATEWAY_IMAGE=ghcr.io/<owner>/monaca-gateway:<sha> \
#   bash remote-deploy.sh
#
# It is a file rather than an inline `ssh "…"` string so it can be read, shellchecked and
# re-run by hand on the host when a deploy fails. No arguments, no secrets: everything it
# needs is in the environment or in the sibling `.env`.
#
# Ordering matters and is explicit here rather than left to compose:
#   1. postgres up, and *verified* ready (a running container is still initdb'ing)
#   2. migrate  — one-shot; §5.4 makes it resumable, so a retry is safe
#   3. bootstrap — one-shot; idempotent by contract (§5.6)
#   4. everything else up
# `docker compose run` does not reliably wait on a `service_healthy` condition, so step 1 is
# polled with pg_isready instead of assumed.

set -euo pipefail

compose() {
  docker compose -f compose.dev.yml --env-file .env "$@"
}

: "${MONACA_SERVER_IMAGE:?MONACA_SERVER_IMAGE must be set (ghcr.io/<owner>/monaca-server:<sha>)}"
: "${MONACA_GATEWAY_IMAGE:?MONACA_GATEWAY_IMAGE must be set (ghcr.io/<owner>/monaca-gateway:<sha>)}"

if [ ! -f .env ]; then
  echo "remote-deploy: no .env in $(pwd)." >&2
  echo "  deploy-dev.yml writes it from the DEPLOY_ENV_FILE secret; see deploy/README.md." >&2
  exit 1
fi

echo "remote-deploy: server=$MONACA_SERVER_IMAGE"
echo "remote-deploy: gateway=$MONACA_GATEWAY_IMAGE"

echo "--- 1/4 postgres"
compose up -d postgres

ready=0
for _ in $(seq 1 60); do
  if compose exec -T postgres pg_isready -U monaca -d monaca_control >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != "1" ]; then
  echo "remote-deploy: postgres never became ready" >&2
  compose logs --tail 100 postgres >&2 || true
  exit 1
fi

echo "--- 2/4 pull"
compose pull

echo "--- 3/4 migrate + bootstrap"
compose run --rm migrate
compose run --rm bootstrap

echo "--- 4/4 up"
compose up -d --remove-orphans

echo "--- state"
compose ps
