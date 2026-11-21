#!/bin/sh
set -eu

REPO="runelay/runelay"
INSTALL_DIR="${RUNELAY_DIR:-$HOME/runelay}"
VERSION="${RUNELAY_VERSION:-latest}"
PORT="${RUNELAY_PORT:-4312}"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:$PORT}"

say() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf 'runelay: %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker não encontrado. Instale em https://docs.docker.com/get-docker/ e rode de novo."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 não encontrado (docker compose)."
docker info >/dev/null 2>&1 || fail "O Docker não está rodando."

say "Instalando runelay em $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"
cd "$INSTALL_DIR"

if [ "$VERSION" = "latest" ]; then
  COMPOSE_URL="https://github.com/$REPO/releases/latest/download/compose.yaml"
else
  COMPOSE_URL="https://github.com/$REPO/releases/download/$VERSION/compose.yaml"
fi
curl -fsSL "$COMPOSE_URL" -o compose.yaml || fail "Não consegui baixar o compose.yaml de $COMPOSE_URL"

if [ ! -f .env ]; then
  random_hex() {
    if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
    else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
  }
  SECRET="$(random_hex 32)"
  SETUP_TOKEN="$(random_hex 18)"
  UPDATER_TOKEN="$(random_hex 24)"
  cat > .env <<ENV
PUBLIC_URL=$PUBLIC_URL
RUNELAY_SECRET=$SECRET
RUNELAY_SETUP_TOKEN=$SETUP_TOKEN
RUNELAY_UPDATER_TOKEN=$UPDATER_TOKEN
ALLOW_SIGNUP=false
RUNELAY_VERSION=$VERSION
RUNELAY_PORT=$PORT
ENV
  chmod 600 .env
  say "Criei o .env com um RUNELAY_SECRET novo. Guarde uma cópia: sem ele as conexões não abrem."
else
  say "Mantive o .env que já existia."
fi

docker compose pull
if ! UP_LOG="$(docker compose up -d 2>&1)"; then
  printf "%s\n" "$UP_LOG" >&2
  case "$UP_LOG" in
    *"address pools have been fully subnetted"*)
      fail "O Docker ficou sem faixas de rede livres. Rode docker network prune -f e instale de novo." ;;
  esac
  fail "docker compose up falhou."
fi

say ""
SETUP_TOKEN="$(grep '^RUNELAY_SETUP_TOKEN=' .env | cut -d= -f2-)"
say "runelay está no ar em $PUBLIC_URL"
if [ -n "$SETUP_TOKEN" ]; then
  say "Crie a conta dona por este link (só ele funciona no primeiro acesso):"
  say "$PUBLIC_URL/login?mode=signup&token=$SETUP_TOKEN"
else
  say "O link de primeiro acesso aparece em: cd $INSTALL_DIR && docker compose logs runelay"
fi
say "Atualizar: pelo botão no painel, ou cd $INSTALL_DIR && docker compose pull && docker compose up -d"
