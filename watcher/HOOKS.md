# Hooks nativos — Camada 1 de detecção (Story 2.2, Epic 2)

> Pré-requisito: watcher já instalado e rodando (`DEPLOY.md`). Este documento
> cobre só a instalação dos hooks nativos do Claude Code e do notify do Codex
> nas sessões `ckpt-*` da VPS.

## 1. Instalar o script

```bash
scp watcher/hooks/ckpt-hook.sh azure:~/.cockpit/
ssh azure 'chmod +x ~/.cockpit/ckpt-hook.sh'
```

## 2. Claude Code — `Notification` e `Stop`

No `~/.claude/settings.json` da VPS (do usuário que roda as sessões `ckpt-*`):

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.cockpit/ckpt-hook.sh notification claude-hook"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.cockpit/ckpt-hook.sh stop claude-hook"
          }
        ]
      }
    ]
  }
}
```

O hook do Claude Code passa o payload nativo (JSON) via stdin — o script lê e
trunca para o campo `raw`; o watcher não depende do formato exato desse JSON
(só de `source`/`event`/`session_name`, que o script controla).

## 3. Codex CLI 0.145.0 — `hooks.json` + trust interativo (resolvido)

Resultado de campo em 2026-07-28, Azure, Codex CLI `0.145.0`. A afirmacao
anterior desta secao ("o Codex nao expoe hook configuravel") era **falsa** para
esta versao, e foi ela que induziu a codificar `HOOK_CAPABLE_AGENTS = {claude}`.

- `notify` em `~/.codex/config.toml` e aceito pelo `codex --strict-config
  doctor`, mas **nao dispara** quando o TUI para em prompt de aprovacao de
  comando. Nao fecha a Camada 1 — descartado.
- `~/.codex/hooks.json` **funciona**, e e o caminho adotado. Hooks novos passam
  por trust interativo no TUI (`Hooks need review`), aprovado uma vez pelo
  operador. **Nao use `--dangerously-bypass-hook-trust`**: ela so serviu para
  provar o mecanismo durante a investigacao.

### Formato instalado

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "/home/ubuntu/.cockpit/ckpt-hook.sh permission_request codex-hook" } ] } ],
    "Stop": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "/home/ubuntu/.cockpit/ckpt-hook.sh stop codex-hook" } ] } ]
  }
}
```

`PermissionRequest` e o sinal da epic (agente parou, espera humano). **`Stop` e
obrigatorio junto**: sem ele a sessao fica `waiting_for_input` para sempre
depois que o operador responde, porque a Camada 2 e cega para TUI. Os dois
mapeiam em `HOOK_EVENT_STATE` (`watcher.mjs`).

### Onde o trust fica gravado

`~/.codex/config.toml`, secao `[hooks.state]`, uma entrada por hook:

```toml
[hooks.state."/home/ubuntu/.codex/hooks.json:permission_request:0:0"]
trusted_hash = "sha256:..."
```

Tres consequencias praticas:

1. **E global, nao por projeto** — fica fora dos blocos `[projects."..."]`.
   Uma aprovacao por maquina.
2. **A chave e o hash da linha de comando.** Mudar o comando derruba o trust e
   o Codex pergunta de novo — bom para seguranca, mas significa que qualquer
   alteracao no `hooks.json` exige uma nova rodada com o operador.
3. **Arquivo presente != capacidade real.** Um `hooks.json` sem trust nao
   executa nada (`/hooks` mostra `Installed 1 / Active 0`). Por isso
   `refreshHookCoverage` checa as duas coisas: o comando no `hooks.json` **e**
   a entrada em `[hooks.state]`.

### Procedimento de instalacao

```bash
# 1. instalar (backup datado, nao-destrutivo)
cp ~/.codex/hooks.json ~/.codex/hooks.json.bak-$(date +%Y%m%d-%H%M%S) 2>/dev/null
# ...gravar o JSON acima...

# 2. o OPERADOR abre uma sessao Codex NOVA (hooks.json e lido no start),
#    roda /hooks, revisa e aprova com `t`. Esperado depois: Active 1 nos dois.

# 3. so entao gravar o marcador por agente
date +%s > ~/.cockpit/hooks-installed-at.codex
```

O marcador e comparado com o inicio do processo do agente: sessao que subiu
antes dele roda sem hook e aparece como `no_hooks` (reciclar resolve; o
`codex resume` traz a conversa de volta).

### Resumo da decisao (`summary`)

Cada agente guarda a pergunta num campo diferente do payload de stdin:

| Agente | Campo |
|---|---|
| Claude Code | `message` |
| Codex | `tool_input.description`, com `tool_name` + `command` como fallback |

`hookSummary()` (`watcher.mjs`) resolve isso. Nunca despejar `raw` cru no
summary: ate 2026-07-28 o operador recebia `{"session_id":"019faa73-...` no
Telegram.

## 4. Smoke manual

Dentro de uma sessão tmux `ckpt-*` real:

```bash
~/.cockpit/ckpt-hook.sh notification claude-hook
curl -s "http://127.0.0.1:4100/decisions?status=pending"
# -> decisão da sessão aparece na fila, risk=high, summary="[hook] aguardando input"

~/.cockpit/ckpt-hook.sh notification claude-hook
curl -s "http://127.0.0.1:4100/decisions?status=pending"
# -> MESMA decisão (id igual), sem duplicata — idempotência (AC7)

~/.cockpit/ckpt-hook.sh stop claude-hook
# -> session_state da sessão vira idle (não cria decisão nova)
```
