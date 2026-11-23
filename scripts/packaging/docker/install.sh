#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
docker load --input image.tar
docker compose -f docker-compose.yaml up -d --pull never
printf "WB Pulse @VERSION@ started: http://localhost:8080\n"
