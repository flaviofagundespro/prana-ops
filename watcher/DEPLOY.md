# Deploy do Prana OPS Watcher (manual, por VPS)

> Deploy é manual, por host, e não há pipeline: o daemon roda de `~/.cockpit/`
> na VPS, não do repositório. Os passos abaixo são autocontidos.

## Pré-requisitos

- Node **>= 18** na VPS (`node --version`).
- Porta livre (default 4100): `ss -tlnp | grep 4100` deve vir vazio; se ocupada,
  ajuste `WATCHER_PORT` no env (passo 2).
- **Confirme o caminho do node** (`which node`) — varia por VPS (nvm, apt,
  binário local). Ajuste `ExecStart=` em `prana-ops-watcher.service` ANTES do
  passo 3 se não for `/usr/local/bin/node`.

## Passos

```bash
# 1. Copiar o daemon COMPLETO para a VPS.
#
#    ATENÇÃO (corrigido em 2026-07-30): até esta data o passo copiava apenas
#    `watcher.mjs`, herdado da Story 2.1, quando o daemon era um arquivo só.
#    As Camadas 2/3 e o Telegram viraram módulos e ninguém atualizou o comando,
#    então TODO deploy limpo terminava em `ERR_MODULE_NOT_FOUND: scanner.mjs`.
#    Só não quebrava em VPS já instalada, onde os módulos estavam de deploys
#    manuais anteriores — na Azure, datados de 16/07 e não documentados.
#    `watcher/test/deploy-doc.test.mjs` agora falha se este comando deixar de
#    listar qualquer import local de watcher.mjs.
#
#    A única dependência de runtime é better-sqlite3 (mesmo driver da Fase 1);
#    se a VPS já roda o cockpit, o binário nativo já está compilado e é deduplicado.
scp watcher/watcher.mjs watcher/scanner.mjs watcher/classifier.mjs watcher/telegram.mjs \
    watcher/package.json azure:~/.cockpit/
ssh azure 'cd ~/.cockpit && npm install --omit=dev'

# 1b. Conferir que o daemon SOBE — o passo que teria pego a falha acima.
#     Um `ERR_MODULE_NOT_FOUND` mata o processo; /health não responde nada e o
#     systemd fica reiniciando em loop.
ssh azure 'node --check ~/.cockpit/watcher.mjs && echo "sintaxe ok"'

# 2. Criar o env com permissão 600 (NUNCA comitar o real)
scp watcher/watcher.env.example azure:~/.cockpit/watcher.env
ssh azure 'chmod 600 ~/.cockpit/watcher.env'   # edite valores se necessário

# 3. Instalar a unit systemd
scp watcher/prana-ops-watcher.service azure:/tmp/
ssh azure 'sudo mv /tmp/prana-ops-watcher.service /etc/systemd/system/ && sudo systemctl daemon-reload'

# 4. Habilitar e iniciar
ssh azure 'sudo systemctl enable --now prana-ops-watcher'

# 5. Verificar — PID e etime, NUNCA só o /health.
#    O /health responde {"ok":true} servido pelo processo ANTIGO se o restart
#    falhou em silêncio (nome de unit errado, módulo faltando, porta ocupada).
#    Foi assim que um "restart" anunciado em 2026-07-29 nunca aconteceu.
ssh azure 'systemctl show prana-ops-watcher -p MainPID -p NRestarts -p SubState'
ssh azure 'ps -eo pid,etime,cmd | grep "watcher.mj[s]"'   # etime tem que ser NOVO
ssh azure 'sudo journalctl -u prana-ops-watcher -n 20 --no-pager'
ssh azure 'curl -s http://127.0.0.1:4100/health'   # → {"ok":true,"db":true}

```

## Camada 1 — hooks nativos (Story 2.2)

Após o watcher estar rodando, instale os hooks do Claude Code/Codex nas
sessões `ckpt-*` — ver `watcher/HOOKS.md`.

## Telegram — a dor morre aqui (Story 2.5)

1. **Criar o bot** (uma vez só): fale com [@BotFather](https://t.me/BotFather)
   no Telegram, `/newbot`, siga o assistente — ele devolve o `TOKEN`.
2. **Obter o `chat_id`**: mande qualquer mensagem para o bot recém-criado,
   depois:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'
   ```
3. Preencher no `watcher.env` (permissão 600, nunca no repo):
   ```
   TELEGRAM_BOT_TOKEN=<token do BotFather>
   TELEGRAM_CHAT_ID=<id do passo 2>
   ```
4. `sudo systemctl restart prana-ops-watcher`
5. **Smoke** (decisão de teste → mensagem chega no celular):
   ```bash
   ssh azure 'curl -s -X POST http://127.0.0.1:4100/hook \
     -H "Content-Type: application/json" \
     -d "{\"source\":\"smoke\",\"session_name\":\"ckpt-smoke-claude-1\",\"decision\":{\"summary\":\"teste do Telegram\"}}"'
   # a mensagem deve chegar no Telegram em poucos segundos
   ```

Sem as duas env vars preenchidas, a camada fica desligada silenciosamente —
nada quebra, só não notifica (mesmo padrão de degradação graciosa da 2.4).

## Smoke rápido pós-deploy

```bash
ssh azure 'curl -s -X POST http://127.0.0.1:4100/hook \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"smoke\",\"session_name\":\"ckpt-smoke-claude-1\",\"decision\":{\"summary\":\"teste de fila\"}}"'
ssh azure 'curl -s http://127.0.0.1:4100/decisions?status=pending'
# limpar: PATCH da decisão criada para dismissed
```

## Invariantes (não relaxar)

- Bind é `127.0.0.1` fixo no código — o app acessa via SSH; nada público.
- `RestartSec=30` + `StartLimitBurst=5/600s` na unit — lição do incidente 2026-07-15.
- Env com chmod 600; segredos nunca no SQLite nem no repo.
