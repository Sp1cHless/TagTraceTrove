[CmdletBinding()]
param(
    [string]$ReleaseDirectory,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'T3-Demo')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$release = Get-Content -LiteralPath (Join-Path $ReleaseDirectory 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$source = Join-Path $ReleaseDirectory ('T3-' + $release.version + '-windows-x64')
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
function Assert-Instance([bool]$Passed, [string]$Message) { if (-not $Passed) { throw "FAILED: $Message" } }
function Get-Owners([int[]]$Ports) {
    return ,@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $Ports } | Sort-Object LocalPort,LocalAddress | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort):$($_.OwningProcess)" })
}
function Wait-Demo([bool]$Running) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $owners = Get-Owners @(8785,8786)
        if ($Running -and @($owners | Where-Object { $_ -match ':8785:' }).Count -and @($owners | Where-Object { $_ -match ':8786:' }).Count) { return }
        if (-not $Running -and $owners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Demo running state did not become $Running"
}
$mainBefore = Get-Owners @(8765,8766)
$desktop = [Environment]::GetFolderPath('Desktop')
$mainShortcut = Join-Path $desktop 'T3.lnk'
$mainShortcutHash = if (Test-Path -LiteralPath $mainShortcut) { (Get-FileHash -LiteralPath $mainShortcut).Hash } else { $null }
Assert-Instance ((Get-Owners @(8785,8786)).Count -eq 0) 'Demo ports were free before installation'
Assert-Instance (-not (Test-Path -LiteralPath (Join-Path $root 'data/library.db'))) 'New Demo library is empty before first start'
& (Join-Path $source 'Install.ps1') -InstallRoot $root -Port 8785 -TlsPort 8786 -InstanceName Demo
$state = Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-Instance ($state.port -eq 8785 -and $state.tlsPort -eq 8786 -and $state.instanceName -eq 'Demo') 'Independent profile persisted'
Assert-Instance ($state.shortcutName -eq 'T3 Demo.lnk') 'Distinct shortcut name'
$shell = New-Object -ComObject WScript.Shell
Assert-Instance ($shell.CreateShortcut((Join-Path $desktop 'T3 Demo.lnk')).TargetPath -eq (Join-Path $state.currentDirectory 'T3.exe')) 'Demo shortcut points at installed Release executable'
& (Join-Path $root 'Start.ps1') -NoBrowser
Wait-Demo $true
$demoBefore = Get-Owners @(8785,8786)
$entries = Invoke-RestMethod 'http://127.0.0.1:8785/api/entries/query' -Method Post -ContentType 'application/json' -Body '{}'
Assert-Instance ($entries.total -eq 0 -and @($entries.items).Count -eq 0) 'Demo contains no personal entries'
$capabilities = Invoke-RestMethod 'http://127.0.0.1:8785/api/sync/capabilities'
$libraryId = $capabilities.libraryId
Assert-Instance (-not [string]::IsNullOrWhiteSpace($libraryId)) 'Demo has its own library identity'
Assert-Instance (Test-Path -LiteralPath (Join-Path $root 'data/private-authorization/tls-certificate.pem')) 'Demo pairing files are in its own data directory'
$demoPid = (Get-NetTCPConnection -LocalPort 8785 -State Listen | Select-Object -First 1).OwningProcess
Assert-Instance ((Get-Process -Id $demoPid).Path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) 'Demo listener uses the installed runtime'
& (Join-Path $root 'Start.ps1') -NoBrowser
Start-Sleep -Milliseconds 800
Assert-Instance (((Get-Owners @(8785,8786)) -join '|') -eq ($demoBefore -join '|')) 'Repeated launch reuses only Demo instance'
Assert-Instance (((Get-Owners @(8765,8766)) -join '|') -eq ($mainBefore -join '|')) 'Main listeners unchanged after Demo launch'
& (Join-Path $root 'Start.ps1') -Stop
Wait-Demo $false
Assert-Instance (((Get-Owners @(8765,8766)) -join '|') -eq ($mainBefore -join '|')) 'Stopping Demo leaves main listeners untouched'
$databaseHash = (Get-FileHash -LiteralPath (Join-Path $root 'data/library.db')).Hash
# An ordinary update invocation must inherit the instance's ports/name.
& (Join-Path $source 'Install.ps1') -InstallRoot $root
$updated = Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-Instance ($updated.port -eq 8785 -and $updated.tlsPort -eq 8786 -and $updated.instanceName -eq 'Demo') 'Update inherited Demo configuration'
Assert-Instance ((Get-FileHash -LiteralPath (Join-Path $root 'data/library.db')).Hash -eq $databaseHash) 'Update retained Demo database'
Assert-Instance (Test-Path -LiteralPath $updated.preUpdateBackup) 'Update created a Demo-only backup'
if ($mainShortcutHash) { Assert-Instance ((Get-FileHash -LiteralPath $mainShortcut).Hash -eq $mainShortcutHash) 'Main shortcut unchanged' }
else { Assert-Instance (-not (Test-Path -LiteralPath $mainShortcut)) 'No main shortcut created by Demo installation' }
& (Join-Path $root 'Start.ps1') -NoBrowser
Wait-Demo $true
$restarted = Invoke-RestMethod 'http://127.0.0.1:8785/api/sync/capabilities'
Assert-Instance ($restarted.libraryId -eq $libraryId) 'Demo identity survived stop/update/restart'
Assert-Instance (((Get-Owners @(8765,8766)) -join '|') -eq ($mainBefore -join '|')) 'Main listeners unchanged throughout check'
$result = @{ version = $release.version; installedRoot = $root; url = 'http://127.0.0.1:8785'; mainListenersUnchanged = $true; initialEntries = 0; ownLibraryIdentity = $true; ownPairingAndShortcut = $true; repeatedLaunch = $true; stopRestartIsolation = $true; updateInheritsProfile = $true; backupAndDataRetained = $true; browserOriginSeparate = $true; demoLeftRunning = $true; phoneChanged = $false }
[IO.File]::WriteAllText((Join-Path $root 'isolation-check.json'), ($result | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Write-Output ($result | ConvertTo-Json -Depth 4)
