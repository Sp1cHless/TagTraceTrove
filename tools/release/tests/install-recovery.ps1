$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$scratch = Join-Path $repo ('.hermes/tmp/install recovery ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
function Assert([bool]$Pass, [string]$Message) { if (-not $Pass) { throw $Message } }
$source = Join-Path $scratch 'payload'
New-Item -ItemType Directory -Path $source | Out-Null
$files = [ordered]@{}
foreach ($name in @('Install.ps1','Install.cmd','lifecycle.ps1','WindowsPathPolicy.cs','Start.ps1','Start.cmd','Uninstall.ps1','Uninstall.cmd','Diagnose.ps1','Diagnose.cmd','DIAGNOSE.zh.txt')) {
    Copy-Item -LiteralPath (Join-Path $repo ('tools/release/' + $name)) -Destination $source
    $files[$name]=(Get-FileHash -LiteralPath (Join-Path $source $name)).Hash.ToLowerInvariant()
}
[IO.File]::WriteAllText((Join-Path $source 'T3.exe'), 'never executed fixture')
$files['T3.exe']=(Get-FileHash -LiteralPath (Join-Path $source 'T3.exe')).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $source 'release-manifest.json'), (@{ product='T3'; platform='win-x64'; version='99.0.0'; files=$files } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
function Run([string]$Mode, [string]$Destination, [string]$Tag) {
    $result = Join-Path $scratch ($Tag + '.json')
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-recovery-runner.ps1') -Installer (Join-Path $source 'Install.ps1') -Destination $Destination -Mode $Mode -ResultFile $result
    Assert ($LASTEXITCODE -eq 0) ('Fixture runner failed: ' + $Mode)
    return (Get-Content -LiteralPath $result -Raw -Encoding UTF8 | ConvertFrom-Json)
}
$destination=Join-Path $scratch ([string][char]0x4e2d + [char]0x6587 + ' & [library]')
New-Item -ItemType Directory -Path (Join-Path $destination 'data') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $destination 'data/keep.txt'),'retain fixture data')
[IO.File]::WriteAllText((Join-Path $destination 'installation.json'),'{"product":"T3","version":"0.0.0","currentDirectory":null,"port":8765,"tlsPort":8766,"instanceName":""}')
$failed=Run 'copy-failure' $destination 'copy-failure'
Assert ($failed.failed -and $failed.version -eq '0.0.0' -and $null -eq $failed.current) 'Failed copy did not retain the resumable state.'
$log=[IO.File]::ReadAllText((Join-Path $source 't3-install.log'))
Assert ($log.Contains('Cannot copy release file') -and $log.Contains('T3.exe') -and $log.Contains('FAILED during')) 'Copy failure stage/filename was not logged.'
$retry=Run 'retry' $destination 'retry'
Assert (-not $retry.failed -and $retry.version -eq '99.0.0') 'Interrupted install did not recover.'
Assert ([IO.File]::ReadAllText((Join-Path $destination 'data/keep.txt')) -eq 'retain fixture data') 'Fixture data was changed.'
$warning=Run 'shortcut-denied' (Join-Path $scratch 'shortcut folder') 'shortcut-denied'
Assert (-not $warning.failed -and $warning.version -eq '99.0.0') 'Optional shortcut failure was still fatal.'
$log=[IO.File]::ReadAllText((Join-Path $source 't3-install.log'))
Assert ($log.Contains('Verifying 1/') -and $log.Contains('Copying 1/') -and $log.Contains('WARNING: shortcut') -and $log.Contains('Installation completed')) 'Progress/completion/warning log is incomplete.'
Assert (Test-Path -LiteralPath (Join-Path $destination 'Diagnose.cmd')) 'Diagnosis entry was not copied to the stable root.'
Push-Location $repo
try {
    & dotnet run --project tools/t3-launcher/T3Launcher.ContractTests -- --bootstrap-recovery
    Assert ($LASTEXITCODE -eq 0) 'Launcher recovery contract failed.'
} finally { Pop-Location }
Write-Host ('PASS: forced copy failure, untouched data/retry, nonfatal shortcut, persisted progress, launcher null recovery. Evidence: ' + $scratch)
