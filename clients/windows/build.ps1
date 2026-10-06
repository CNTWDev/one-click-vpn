param(
  [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64',
  # Release builds pass both; the fourth assembly field is the build number update checks compare.
  [string]$Version = '',
  [int]$Build = 0
)
$ErrorActionPreference = 'Stop'
$output = Join-Path $PSScriptRoot "artifacts/$Runtime"
$properties = @()
if ($Version -and $Build -gt 0) {
  if ($Build -gt 65535) { throw 'Windows build numbers must fit the assembly revision field (<= 65535)' }
  $properties = @("-p:Version=$Version", "-p:AssemblyVersion=$Version.$Build", "-p:FileVersion=$Version.$Build")
}
dotnet publish (Join-Path $PSScriptRoot 'Veilbird/Veilbird.csproj') -c Release -r $Runtime --self-contained true -o $output @properties
if ($LASTEXITCODE -ne 0) { throw 'Veilbird build failed' }
$name = if ($properties.Count) { "Veilbird-$Version-$Build-$Runtime.zip" } else { "Veilbird-dev-$Runtime.zip" }
Compress-Archive -Path "$output/*" -DestinationPath (Join-Path $PSScriptRoot "artifacts/$name") -Force
Write-Host "Built $name (not code-signed)."
