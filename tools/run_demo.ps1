param(
  [string]$Students = "demo\students.csv",
  [string]$Config = "demo\config.demo.json"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Students)) {
  throw "Demo students file not found: $Students"
}

if (-not (Test-Path $Config)) {
  throw "Demo config file not found: $Config"
}

$mockPagePath = (Resolve-Path "demo\mock_query.html").Path
$mockPageUrl = "$(([System.Uri]$mockPagePath).AbsoluteUri)?autoCaptcha=1"

python tools\normalize_students.py --input $Students --out work\demo_students.csv
if ($LASTEXITCODE -ne 0) {
  throw "Normalize step failed."
}

$queryArgs = @(
  "run",
  "query",
  "--",
  "--students",
  "work\demo_students.csv",
  "--config",
  $Config,
  "--output-dir",
  "output\demo",
  "--results",
  "output\demo\results.jsonl",
  "--events",
  "output\demo\events.jsonl",
  "--failed-log",
  "output\demo\failed_students.csv",
  "--control-file",
  "output\demo\control.json",
  "--url",
  $mockPageUrl
)

& npm @queryArgs
if ($LASTEXITCODE -ne 0) {
  throw "Query step failed."
}

python tools\build_summary.py --results output\demo\results.jsonl --out output\demo\summary.xlsx
if ($LASTEXITCODE -ne 0) {
  throw "Summary step failed."
}

Write-Host ""
Write-Host "Demo complete."
Write-Host "Screenshots: output\demo\screenshots"
Write-Host "Raw results: output\demo\results.jsonl"
Write-Host "Events: output\demo\events.jsonl"
Write-Host "Summary workbook: output\demo\summary.xlsx"
