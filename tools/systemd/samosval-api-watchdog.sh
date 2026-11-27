#!/usr/bin/env bash
# Сторож API «Учёт самосвалов» (рабочая + тестовая линии, общий API).
# Задача: после перезагрузки сервера и при любом падении контейнера вернуть API в строй.
# Запускается systemd-таймером samosval-api-watchdog.timer (каждую минуту + после загрузки).
set -u

LOG=/var/log/samosval-api-watchdog.log
API=samosval-api-working-test
DB=samosval-postgres-ubuntu
HEALTH_URL=http://127.0.0.1:18091/health/ready
MAXLOG=1048576

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

# Ротация: один архив, без разрастания лога
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$MAXLOG" ]; then
  mv -f "$LOG" "$LOG.1"
fi

running() { docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo missing; }

# 1. База: без неё API не готов
if [ "$(running "$DB")" != "true" ]; then
  log "база $DB не запущена ($(running "$DB")) — поднимаю"
  docker start "$DB" >/dev/null 2>&1 || log "не удалось запустить $DB"
  sleep 5
fi

# 2. Контейнер API
if [ "$(running "$API")" != "true" ]; then
  log "API $API не запущен ($(running "$API")) — поднимаю"
  # политика перезапуска должна переживать перезагрузку сервера
  policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$API" 2>/dev/null || echo missing)
  if [ "$policy" != "unless-stopped" ]; then
    docker update --restart unless-stopped "$API" >/dev/null 2>&1 && log "политика перезапуска $API: $policy -> unless-stopped"
  fi
  docker start "$API" >/dev/null 2>&1 || log "не удалось запустить $API"
  sleep 6
fi

# 3. Готовность: живой процесс ещё не значит «база подключена»
code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)
[ -n "$code" ] || code=000
if [ "$code" != "200" ]; then
  log "health/ready вернул $code — перезапускаю $API"
  docker restart "$API" >/dev/null 2>&1 || log "не удалось перезапустить $API"
  sleep 10
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)
  [ -n "$code" ] || code=000
  if [ "$code" = "200" ]; then log "API восстановлен после перезапуска"; else log "API всё ещё не готов, health/ready=$code"; fi
fi
