param([ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64')
$ErrorActionPreference = 'Stop'
$output = Join-Path $PSScriptRoot "artifacts/$Runtime"
dotnet publish (Join-Path $PSScriptRoot 'Northstar/Northstar.csproj') -c Release -r $Runtime --self-contained true -o $output
if ($LASTEXITCODE -ne 0) { throw 'NORTHSTAR build failed' }
Compress-Archive -Path "$output/*" -DestinationPath (Join-Path $PSScriptRoot "artifacts/NORTHSTAR-dev-$Runtime.zip") -Force
Write-Host 'Development ZIP only. Not signed, not a VPN-ready release.'
