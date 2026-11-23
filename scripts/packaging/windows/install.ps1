$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:LOCALAPPDATA 'WB-Pulse'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($file in @('wb-pulse.exe','start.cmd','README.md','CHANGELOG.md','INSTALL.txt')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $destination -Force }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'WB Pulse.lnk'))
$link.TargetPath = Join-Path $destination 'start.cmd'
$link.WorkingDirectory = $destination
$link.IconLocation = Join-Path $destination 'wb-pulse.exe'
$link.Save()
Write-Host "Installed to $destination. Open WB Pulse from the Start menu."
