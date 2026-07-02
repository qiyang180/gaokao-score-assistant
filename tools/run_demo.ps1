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

$demoConfig = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
$mockPagePath = (Resolve-Path "demo\mock_query.html").Path
$mockPageUrl = "$(([System.Uri]$mockPagePath).AbsoluteUri)" + $(if ($demoConfig.skipCaptchaPrompt) {'?autoCaptcha=1'} else {''})

node tools\normalize_students.mjs --input $Students --out work\demo_students.csv
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
  $mockPageUrl,
  "--demo"
)

& npm @queryArgs
if ($LASTEXITCODE -ne 0) {
  throw "Query step failed."
}

node tools\build_summary.mjs --results output\demo\results.jsonl --students work\demo_students.csv --out output\demo\summary.xlsx
if ($LASTEXITCODE -ne 0) {
  throw "Summary step failed."
}

Write-Host ""
Write-Host "Demo complete."
Write-Host "Screenshots: output\demo\screenshots"
Write-Host "Raw results: output\demo\results.jsonl"
Write-Host "Events: output\demo\events.jsonl"
Write-Host "Summary workbook: output\demo\summary.xlsx"
