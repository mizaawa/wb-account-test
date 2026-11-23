#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${PREFIX:-/usr/local}
install -d "$prefix/bin"
install -m 0755 "$base/wb-pulse" "$prefix/bin/wb-pulse"
printf 'Installed %s/bin/wb-pulse\nStart: ADDR=127.0.0.1:8080 %s/bin/wb-pulse\n' "$prefix" "$prefix"
