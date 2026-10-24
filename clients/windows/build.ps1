param(
  [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64',
  # Release builds pass both; the fourth assembly field is the build number update checks compare.
  [string]$Version = '',
  [int]$Build = 0,
  # Also produce TrackNothing-<version>-<build>-<runtime>-setup.exe (Inno Setup), the file users install.
  [switch]$Installer
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-tunnel.ps1') -Runtime $Runtime
$output = Join-Path $PSScriptRoot "artifacts/$Runtime"
$properties = @()
if ($Version -and $Build -gt 0) {
  if ($Build -gt 65535) { throw 'Windows build numbers must fit the assembly revision field (<= 65535)' }
  $properties = @("-p:Version=$Version", "-p:AssemblyVersion=$Version.$Build", "-p:FileVersion=$Version.$Build")
}
dotnet publish (Join-Path $PSScriptRoot 'Veilbird/Veilbird.csproj') -c Release -r $Runtime --self-contained true -o $output @properties
if ($LASTEXITCODE -ne 0) { throw 'TrackNothing build failed' }
foreach ($library in 'tunnel.dll', 'wireguard.dll') { if (-not (Test-Path "$output/$library")) { throw "$library missing from the build output" } }
$name = if ($properties.Count) { "TrackNothing-$Version-$Build-$Runtime.zip" } else { "TrackNothing-dev-$Runtime.zip" }
Compress-Archive -Path "$output/*" -DestinationPath (Join-Path $PSScriptRoot "artifacts/$name") -Force
Write-Host "Built $name (not code-signed)."
if ($Installer) {
  if (-not $properties.Count) { throw '-Installer needs -Version and -Build' }
  $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
  if (-not (Test-Path $iscc)) { choco install innosetup -y --no-progress | Out-Null }
  & $iscc /Q "/DVersion=$Version" "/DBuild=$Build" "/DRuntime=$Runtime" (Join-Path $PSScriptRoot 'installer.iss')
  if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
  Write-Host "Built TrackNothing-$Version-$Build-$Runtime-setup.exe (not code-signed)."
}
