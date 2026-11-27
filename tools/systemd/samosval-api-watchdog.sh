#!/usr/bin/env bash
# Сторож API «Учёт самосвалов»: РАБОЧАЯ версия (api-samosval) и тестовый канал (samosval-test).
# Задача: после перезагрузки сервера и при любом падении контейнера вернуть API в строй.
# Запускается systemd-таймером samosval-api-watchdog.timer (каждую минуту + после загрузки).
set -u

LOG=/var/log/samosval-api-watchdog.log
DB=samosval-postgres-ubuntu
MAXLOG=1048576

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

# Ротация: один архив, без разрастания лога
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$MAXLOG" ]; then
  mv -f "$LOG" "$LOG.1"
fi

running() { docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo missing; }

# 1. База: без неё ни один API не готов
if [ "$(running "$DB")" != "true" ]; then
  log "база $DB не запущена ($(running "$DB")) — поднимаю"
  docker start "$DB" >/dev/null 2>&1 || log "не удалось запустить $DB"
  sleep 5
fi

# 2. Контейнеры API: рабочая версия и тестовый канал
check_api() { # $1=контейнер $2=порт
  local api="$1" port="$2" url="http://127.0.0.1:$2/health/ready" code policy
  if [ "$(running "$api")" != "true" ]; then
    log "API $api не запущен ($(running "$api")) — поднимаю"
    policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$api" 2>/dev/null || echo missing)
    if [ "$policy" != "unless-stopped" ]; then
      docker update --restart unless-stopped "$api" >/dev/null 2>&1 && log "политика перезапуска $api: $policy -> unless-stopped"
    fi
    docker start "$api" >/dev/null 2>&1 || log "не удалось запустить $api"
    sleep 6
  fi
  # Готовность: живой процесс ещё не значит «база подключена»
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null)
  [ -n "$code" ] || code=000
  if [ "$code" != "200" ]; then
    log "health/ready ($api) вернул $code — перезапускаю"
    docker restart "$api" >/dev/null 2>&1 || log "не удалось перезапустить $api"
    sleep 10
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null)
    [ -n "$code" ] || code=000
    if [ "$code" = "200" ]; then log "API $api восстановлен после перезапуска"; else log "API $api всё ещё не готов, health/ready=$code"; fi
  fi
}

# Рабочая версия — приоритет: её проверяем первой.
check_api samosval-api-prod 18092
check_api samosval-api-working-test 18091
