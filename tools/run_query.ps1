param(
  [string]$Students = "data\students.xlsx",
  [string]$Config = "config.local.json",
  [string]$OutputDir = "output",
  [int]$Start = 1,
  [switch]$Resume,
  [switch]$ResetResults,
  [string]$FailedLog = "",
  [string]$Url = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Students)) {
  throw "Student file not found: $Students. Put it at data\students.xlsx or pass -Students."
}

if (-not (Test-Path $Config) -and $Config -eq "config.local.json" -and (Test-Path "config.example.json")) {
  $Config = "config.example.json"
}
if (-not (Test-Path $Config)) {
  throw "Config file not found: $Config"
}

python tools\normalize_students.py --input $Students --out work\students.csv
if ($LASTEXITCODE -ne 0) {
  throw "Student normalization failed."
}

$Results = Join-Path $OutputDir "results.jsonl"
$Events = Join-Path $OutputDir "events.jsonl"
$ControlFile = Join-Path $OutputDir "control.json"
$Summary = Join-Path $OutputDir "score_summary.xlsx"
if (-not $FailedLog.Trim()) {
  $FailedLog = Join-Path $OutputDir "failed_students.csv"
}

$queryArgs = @(
  "run",
  "query",
  "--",
  "--students",
  "work\students.csv",
  "--config",
  $Config,
  "--output-dir",
  $OutputDir,
  "--results",
  $Results,
  "--events",
  $Events,
  "--control-file",
  $ControlFile,
  "--start",
  $Start,
  "--failed-log",
  $FailedLog
)
if ($Resume) {
  $queryArgs += "--resume"
}
if ($ResetResults) {
  $queryArgs += "--reset-results"
}
if ($Url.Trim()) {
  $queryArgs += @("--url", $Url)
}

& npm @queryArgs
if ($LASTEXITCODE -ne 0) {
  throw "Score query failed."
}

& npm run summary -- --results $Results --students "work\students.csv" --out $Summary
if ($LASTEXITCODE -ne 0) {
  throw "Summary generation failed."
}

Write-Host ""
Write-Host "Done. Screenshots: $(Join-Path $OutputDir "screenshots"). Failed log: $FailedLog. Summary: $Summary."
