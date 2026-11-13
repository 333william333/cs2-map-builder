<#
.SYNOPSIS
  Copies mod/dist/CS2MapBuilder/ into %LocalLow%\Colossal Order\Cities Skylines II\Mods\CS2MapBuilder\
  and creates the packages folder ModsData\CS2MapBuilder\packages\. Run build.ps1 first.
  Restart the game afterwards (mod DLLs are loaded once at startup).

.PARAMETER WithSample
  Also copy mod/sample-package into the packages folder as 'sample-package'.
#>
[CmdletBinding()]
param([switch]$WithSample)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist\CS2MapBuilder'
$dll = Join-Path $dist 'CS2MapBuilder.Mod.dll'
if (-not (Test-Path -LiteralPath $dll)) {
    Write-Error "Nothing to install: '$dll' not found. Run ./build.ps1 first."
    exit 1
}

if (Get-Process -Name 'Cities2' -ErrorAction SilentlyContinue) {
    Write-Error 'Cities: Skylines II (Cities2.exe) is running. Close the game first; the mod DLL is loaded once at startup.'
    exit 1
}

$userData = Join-Path $env:USERPROFILE 'AppData\LocalLow\Colossal Order\Cities Skylines II'
if (-not (Test-Path -LiteralPath $userData)) {
    Write-Error "Game user folder not found: '$userData'. Start the game once first."
    exit 1
}

$target = Join-Path $userData 'Mods\CS2MapBuilder'
$disabled = Join-Path $userData 'Mods\.CS2MapBuilder'
if (Test-Path -LiteralPath $disabled) {
    Write-Warning "A disabled copy exists at '$disabled'; it is left alone."
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $dist '*') -Destination $target -Recurse -Force
Write-Host "Installed to $target"

$packages = Join-Path $userData 'ModsData\CS2MapBuilder\packages'
New-Item -ItemType Directory -Force -Path $packages | Out-Null
Write-Host "Packages folder: $packages"

if ($WithSample) {
    $sampleTarget = Join-Path $packages 'sample-package'
    New-Item -ItemType Directory -Force -Path $sampleTarget | Out-Null
    Copy-Item -Path (Join-Path $root 'sample-package\*') -Destination $sampleTarget -Recurse -Force
    Write-Host "Sample package copied to $sampleTarget"
}
Write-Host 'Restart Cities: Skylines II to load the mod.'
