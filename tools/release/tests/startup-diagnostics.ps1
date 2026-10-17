$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$scratch = Join-Path $repo ('.hermes/tmp/startup diagnostics ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$script = Join-Path $repo 'tools/release/Diagnose.ps1'
function Assert([bool]$Value, [string]$Reason) { if (-not $Value) { throw $Reason } }
function Diagnose([string]$Folder, [string]$Name) {
    $report = Join-Path $scratch ($Name + '.txt')
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Root $Folder -OutputPath $report
    Assert ($LASTEXITCODE -eq 0) ('Diagnostic command failed: ' + $Name)
    return [IO.File]::ReadAllText($report)
}
$packaged = Join-Path $repo '.releases/1.0.10/TagTraceTrove'
$before = (Get-FileHash -LiteralPath (Join-Path $packaged 'T3.exe')).Hash
$complete = Diagnose $packaged 'complete-package'
Assert ($complete.Contains('isolated native module OK 1')) 'Bundled native dependency was not exercised in memory.'
Assert ($complete.Contains('missing: 0; invalid paths: 0')) 'Complete-package manifest presence check failed.'
Assert ($complete.Contains('Original installer package check: PASS / 6971 files')) 'The shipped installer hash/path checks were not exercised.'
Assert ($complete.Contains('No existing log.')) 'Report did not handle a failure before logs existed.'
Assert ((Get-FileHash -LiteralPath (Join-Path $packaged 'T3.exe')).Hash -eq $before) 'Diagnostic changed the published EXE.'

$broken = Join-Path $scratch 'incomplete installation'
New-Item -ItemType Directory -Path $broken | Out-Null
[IO.File]::WriteAllText((Join-Path $broken 'installation.json'), '{"product":"T3","version":"0.0.0","currentDirectory":null}')
$brokenReport = Diagnose $broken 'incomplete-installation'
Assert ($brokenReport.Contains('currentDirectory is empty')) 'Incomplete installation was not explained.'
Assert ($brokenReport.Contains('Bundled node.exe is missing.')) 'A missing EXE/dependency prevented remaining sections.'

$missing = Join-Path $scratch 'partial extraction'
New-Item -ItemType Directory -Path $missing | Out-Null
[IO.File]::WriteAllText((Join-Path $missing 'release-manifest.json'), '{"product":"T3","version":"1.0.10","files":{"apps/web/dist/index.html":"0000","../outside":"0000"}}')
$partial = Diagnose $missing 'partial-extraction'
Assert ($partial.Contains('missing: 1; invalid paths: 1')) 'Missing/outside manifest entries were not reported.'
Assert (-not (Test-Path -LiteralPath (Join-Path $broken 'data'))) 'Diagnostic created installation data.'
Assert (-not (Test-Path -LiteralPath (Join-Path $packaged 'data'))) 'Diagnostic installed or started the release.'

# Exercise the same default-root binding used by a double-clicked CMD.
Copy-Item -LiteralPath $script -Destination (Join-Path $broken 'Diagnose.ps1')
$defaultReport = Join-Path $scratch 'default-root.txt'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $broken 'Diagnose.ps1') -OutputPath $defaultReport
Assert ($LASTEXITCODE -eq 0) 'Default-root invocation failed.'
Assert ([IO.File]::ReadAllText($defaultReport).Contains('Requested folder: ' + $broken)) 'Default root was bound before PSScriptRoot was available.'
Write-Host ('PASS: complete package, incomplete installation, partial extraction, default folder; evidence: ' + $scratch)
