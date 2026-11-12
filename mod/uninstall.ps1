<#
.SYNOPSIS
  Removes %LocalLow%\Colossal Order\Cities Skylines II\Mods\CS2MapBuilder\.
  Packages, settings and logs in ModsData\CS2MapBuilder\ are kept unless -RemoveData is given.
#>
[CmdletBinding()]
param([switch]$RemoveData)

$ErrorActionPreference = 'Stop'
$userData = Join-Path $env:USERPROFILE 'AppData\LocalLow\Colossal Order\Cities Skylines II'
$target = Join-Path $userData 'Mods\CS2MapBuilder'

if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "Removed $target"
} else {
    Write-Host "Not installed: $target does not exist."
}

if ($RemoveData) {
    $data = Join-Path $userData 'ModsData\CS2MapBuilder'
    if (Test-Path -LiteralPath $data) {
        Remove-Item -LiteralPath $data -Recurse -Force
        Write-Host "Removed $data (packages, import.log, prefabs.txt)"
    }
}
Write-Host 'Restart Cities: Skylines II for the change to take effect.'
