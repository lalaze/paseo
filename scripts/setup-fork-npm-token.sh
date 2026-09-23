#!/usr/bin/env bash
set -euo pipefail
umask 077

config_file="${PASEO_NPM_USERCONFIG:-$HOME/.config/paseo/npm-release.npmrc}"
mkdir -p "$(dirname "$config_file")"
temporary_config="$(mktemp "${config_file}.XXXXXX")"
trap 'rm -f "$temporary_config"' EXIT

read -r -s -p "Paste the npm publishing token (hidden): " publishing_token
printf '\n'
if [[ "$publishing_token" != npm_* ]]; then
  printf 'Expected an npm granular access token.\n' >&2
  exit 1
fi
printf '//registry.npmjs.org/:_authToken=%s\n' "$publishing_token" > "$temporary_config"
unset publishing_token

account="$(npm whoami --userconfig="$temporary_config" --registry=https://registry.npmjs.org/)"
if [[ "$account" != lalaze ]]; then
  printf 'Expected npm account lalaze; received %s.\n' "$account" >&2
  exit 1
fi

mv "$temporary_config" "$config_file"
printf 'Publishing token saved to %s (owner access only).\n' "$config_file"
