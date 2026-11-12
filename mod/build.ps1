<#
.SYNOPSIS
  Builds the CS2 Map Builder importer mod (Release) into mod/dist/CS2MapBuilder/.

.PARAMETER GamePath
  Cities: Skylines II install folder (the one that contains Cities2_Data). Defaults to the Steam location.

.PARAMETER SkipTests
  Do not build and run the out-of-game package reader self test (PackageCheck selftest).

.EXAMPLE
  ./build.ps1
  ./build.ps1 -GamePath 'D:\SteamLibrary\steamapps\common\Cities Skylines II'
#>
[CmdletBinding()]
param(
    [string]$GamePath = 'C:\Program Files (x86)\Steam\steamapps\common\Cities Skylines II',
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$managed = Join-Path $GamePath 'Cities2_Data\Managed'

if (-not (Test-Path -LiteralPath (Join-Path $managed 'Game.dll'))) {
    Write-Error "Game.dll not found in '$managed'. Pass the game folder with -GamePath '<...>\Cities Skylines II'."
    exit 1
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error 'The .NET SDK (dotnet) is not on PATH. Install the .NET SDK 8 or newer.'
    exit 1
}

$project = Join-Path $root 'CS2MapBuilder.Mod\CS2MapBuilder.Mod.csproj'
Write-Host "Building $project against $managed"
& dotnet build $project -c Release -nologo "-p:ManagedPath=$managed"
if ($LASTEXITCODE -ne 0) { Write-Error "Mod build failed (exit $LASTEXITCODE)."; exit $LASTEXITCODE }

$out = Join-Path $root 'CS2MapBuilder.Mod\bin\Release'
$dist = Join-Path $root 'dist\CS2MapBuilder'
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# Only our own assembly is deployed; every game DLL (incl. Newtonsoft.Json) is provided by the game.
Copy-Item -LiteralPath (Join-Path $out 'CS2MapBuilder.Mod.dll') -Destination $dist
if (Test-Path -LiteralPath (Join-Path $out 'CS2MapBuilder.Mod.pdb')) {
    Copy-Item -LiteralPath (Join-Path $out 'CS2MapBuilder.Mod.pdb') -Destination $dist
}
$unexpected = Get-ChildItem -LiteralPath $out -Filter *.dll | Where-Object { $_.Name -ne 'CS2MapBuilder.Mod.dll' }
if ($unexpected) {
    Write-Warning ("Build output contains other DLLs that are NOT deployed: " + (($unexpected | ForEach-Object Name) -join ', '))
}

if (-not $SkipTests) {
    $check = Join-Path $root 'CS2MapBuilder.PackageCheck\CS2MapBuilder.PackageCheck.csproj'
    Write-Host 'Building and running the package reader self test'
    & dotnet build $check -c Release -nologo "-p:ManagedPath=$managed"
    if ($LASTEXITCODE -ne 0) { Write-Error "PackageCheck build failed (exit $LASTEXITCODE)."; exit $LASTEXITCODE }
    & (Join-Path $root 'CS2MapBuilder.PackageCheck\bin\Release\PackageCheck.exe') selftest (Join-Path $root 'sample-package')
    if ($LASTEXITCODE -ne 0) { Write-Error "Package reader self test failed (exit $LASTEXITCODE)."; exit $LASTEXITCODE }
}

Write-Host ''
Write-Host "Done: $dist"
Get-ChildItem -LiteralPath $dist | ForEach-Object { Write-Host ("  {0}  {1:N0} bytes" -f $_.Name, $_.Length) }
Write-Host 'Install with ./install.ps1 (copies to %LocalLow%\Colossal Order\Cities Skylines II\Mods\CS2MapBuilder).'
