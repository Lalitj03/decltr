#!/usr/bin/env bash
# Kept so existing instructions keep working. The real work is in decltr-service.sh.
exec "$(dirname "${BASH_SOURCE[0]}")/decltr-service.sh" install "$@"
