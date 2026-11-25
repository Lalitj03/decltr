#!/usr/bin/env bash
# Kept so existing instructions keep working. The real work is in decltr-service.sh.
# Your Keychain entries are left alone. Delete them with:
#   security delete-generic-password -s decltr -a vertex-api-key
exec "$(dirname "${BASH_SOURCE[0]}")/decltr-service.sh" uninstall
