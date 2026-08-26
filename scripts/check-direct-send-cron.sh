#!/usr/bin/env bash
# Wrapper de cron para scripts/check-direct-send.mjs.
#
# Roda a verificação, guarda uma linha por execução no log e, na TRANSIÇÃO para
# habilitado, cria um arquivo-marcador. O marcador é o que importa: o log é
# histórico, o marcador é o alerta.
#
# Instalado no crontab do usuário ubuntu. Ver: crontab -l
set -uo pipefail

REPO="/opt/apps/waba"
NODE="/home/ubuntu/.nvm/versions/node/v24.15.0/bin/node"
LOG="$REPO/data/direct-send-check.log"
MARCADOR="$REPO/data/DIRECT-SEND-HABILITADO"
AGORA="$(date -Is)"

# A chave de cifra vive no container da API; nunca é escrita em disco aqui.
KEY="$(docker exec waba-api-1 printenv APP_ENCRYPTION_KEY 2>/dev/null)"
if [ -z "$KEY" ]; then
  echo "$AGORA erro: nao foi possivel ler APP_ENCRYPTION_KEY do container waba-api-1" >> "$LOG"
  exit 1
fi

SAIDA="$(APP_ENCRYPTION_KEY="$KEY" "$NODE" "$REPO/scripts/check-direct-send.mjs" 2>&1)"
CODIGO=$?
unset KEY

if [ "$CODIGO" -eq 10 ]; then
  echo "$AGORA HABILITADO" >> "$LOG"
  # Só grava o marcador na primeira vez, para preservar a data da virada.
  if [ ! -f "$MARCADOR" ]; then
    {
      echo "Direct Send foi habilitado pela Meta em $AGORA"
      echo
      echo "$SAIDA"
    } > "$MARCADOR"
  fi
elif [ "$CODIGO" -eq 0 ]; then
  echo "$AGORA nao habilitado" >> "$LOG"
else
  echo "$AGORA erro (codigo $CODIGO): $(echo "$SAIDA" | tr '\n' ' ' | cut -c1-300)" >> "$LOG"
fi

# Mantém o log enxuto — uma linha por semana não cresce, mas erros em rajada sim.
tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
