param(
  [string]$Students = "data\students.xlsx",
  [string]$Config = "config.local.json",
  [string]$Url = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Students)) {
  throw "Student file not found: $Students. Put it at data\students.xlsx or pass -Students."
}

python tools\normalize_students.py --input $Students --out work\students.csv
if ($LASTEXITCODE -ne 0) {
  throw "Student normalization failed."
}

$queryArgs = @("run", "query", "--", "--students", "work\students.csv", "--config", $Config)
if ($Url.Trim()) {
  $queryArgs += @("--url", $Url)
}

& npm @queryArgs
if ($LASTEXITCODE -ne 0) {
  throw "Score query failed."
}

& npm run summary
if ($LASTEXITCODE -ne 0) {
  throw "Summary generation failed."
}

Write-Host ""
Write-Host "Done. Screenshots: output\screenshots. Summary: output\score_summary.xlsx or output\成绩汇总.xlsx."
