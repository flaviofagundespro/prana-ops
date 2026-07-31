#!/bin/sh
# Prana OPS — hook nativo (Claude Code / Codex) -> watcher POST /hook (Story 2.2).
#
# Uso: ckpt-hook.sh <event> [source]
#   event:  notification | stop (outros valores sao aceitos e apenas auditados)
#   source: claude-hook (default) | codex-notify | ...
#
# Invariantes (nao relaxar):
#  - NAO filtra por prefixo ckpt- aqui: a allowlist e' responsabilidade do
#    watcher (2.1/AC4), fonte unica do invariante (Story 2.2/AC2).
#  - NUNCA bloqueia nem derruba o agente chamador: timeout curto no curl e
#    "|| true" em toda saida — falha do watcher e' silenciosa (Story 2.2/AC1).
#  - POSIX sh, sem bashismos: pode rodar em contexto minimo de hook.

set -eu

EVENT="${1:-}"
SOURCE="${2:-claude-hook}"
PORT="${WATCHER_PORT:-4100}"

if [ -z "$EVENT" ]; then
  exit 0
fi

# Fora de uma sessao tmux, display-message falha e SESSION_NAME fica vazio —
# o script sai sem enviar nada (nao ha sessao para reportar).
SESSION_NAME="$(tmux display-message -p '#S' 2>/dev/null || true)"
if [ -z "$SESSION_NAME" ]; then
  exit 0
fi

# Payload nativo do hook (se houver) chega via stdin; truncado, nunca lido
# alem do necessario para o summary provisorio (o classificador da 2.4 refina).
RAW=""
if [ ! -t 0 ]; then
  RAW="$(head -c 2000 2>/dev/null || true)"
fi

# Escape minimo de JSON (sem libs externas): barra invertida, aspas, e
# quebras de linha viram espaco para manter o payload numa linha.
RAW_ESCAPED=$(printf '%s' "$RAW" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
SESSION_ESCAPED=$(printf '%s' "$SESSION_NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')

PAYLOAD=$(printf '{"source":"%s","event":"%s","session_name":"%s","raw":"%s"}' \
  "$SOURCE" "$EVENT" "$SESSION_ESCAPED" "$RAW_ESCAPED")

# </dev/null: o curl NUNCA pode herdar o stdin do script (o hook runner do
# Claude Code alimenta este script via pipe) — sem isso, curl fica preso ate
# --max-time expirar em vez de retornar na hora (achado real de teste).
curl --max-time 2 -s -o /dev/null -X POST \
  "http://127.0.0.1:${PORT}/hook" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  </dev/null \
  || true

exit 0
