# Takes a headless Edge screenshot of the running Tickpack app (QA + sharing).
# Usage:
#   pwsh -File scripts/shot.ps1 -Sample spiral -Auto 60
#   pwsh -File scripts/shot.ps1 -Sample square -Auto 12 -Tick 12 -Out shots/tick12.png
param(
  [string]$Sample = 'square',
  [int]$Auto = 0,
  [int]$Tick = -1,
  [int]$W = 1440,
  [int]$H = 900,
  [string]$Speed = '',
  [string]$Out = ''
)

$repo = Split-Path -Parent $PSScriptRoot
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { throw "Edge not found at $edge" }
if (-not $Out) {
  $Out = Join-Path $repo "shots/ui-$Sample-$Auto.png"
}
$Out = [System.IO.Path]::GetFullPath($Out)
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$url = "http://127.0.0.1:8123/?sample=$Sample"
if ($Auto -gt 0) { $url += "&auto=$Auto" }
if ($Tick -ge 0) { $url += "&t=$Tick" }
if ($Speed) { $url += "&speed=$Speed" }

Write-Host "screenshot: $url -> $Out"
& $edge --headless=new --disable-gpu --hide-scrollbars --no-first-run `
  "--window-size=$W,$H" --virtual-time-budget=8000 "--screenshot=$Out" $url | Out-Null

if (-not (Test-Path $Out)) { throw "screenshot failed" }
Write-Host "ok: $Out ($((Get-Item $Out).Length) bytes)"
