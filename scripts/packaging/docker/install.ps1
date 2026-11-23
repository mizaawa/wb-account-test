$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  docker load --input image.tar
  if ($LASTEXITCODE -ne 0) { throw "Docker image loading failed" }
  docker compose -f docker-compose.yaml up -d --pull never
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose deployment failed" }
  Write-Host "WB Pulse @VERSION@ started: http://localhost:8080"
} finally { Pop-Location }
