# Builds tunnel.dll from wireguard-windows' embeddable service and takes the signed wireguard.dll
# (wireguard-nt) it downloads, into clients/windows/.deps/<runtime>/. Veilbird.csproj ships both next to Veilbird.exe.
# Upstream's build.bat pins and verifies every toolchain download (Go, llvm-mingw, wireguard-nt).
param([ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64')
$ErrorActionPreference = 'Stop'
$tag = 'v1.1.1'; $revision = 'f0605c3e3dcc5ff801e19158fd6255378b99e17c'
$source = Join-Path $PSScriptRoot '.deps/wireguard-windows'
$arch = @{ 'win-x64' = 'amd64'; 'win-arm64' = 'arm64' }[$Runtime]
$target = Join-Path $PSScriptRoot ".deps/$Runtime"
if ((Test-Path "$target/tunnel.dll") -and (Test-Path "$target/wireguard.dll")) { Write-Host "Tunnel libraries already in $target"; exit 0 }
if (-not (Test-Path "$source/.git")) { git clone --quiet --depth 1 --branch $tag https://github.com/WireGuard/wireguard-windows $source }
if ((git -C $source rev-parse HEAD) -ne $revision) { throw "wireguard-windows $tag is not at the pinned revision" }
if (-not (Test-Path "$source/embeddable-dll-service/$arch/tunnel.dll")) {
  cmd /c "`"$source\embeddable-dll-service\build.bat`""
  if ($LASTEXITCODE -ne 0) { throw 'tunnel.dll build failed' }
}
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item "$source/embeddable-dll-service/$arch/tunnel.dll" $target
Copy-Item "$source/.deps/wireguard-nt/bin/$arch/wireguard.dll" $target
Copy-Item "$source/.deps/wireguard-nt/LICENSE.txt" (Join-Path $target 'wireguard-nt-LICENSE.txt') -ErrorAction SilentlyContinue
Write-Host "Tunnel libraries for $Runtime in $target"
