$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
. (Join-Path $repo 'tools/release/lifecycle.ps1')
function Assert([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
$scratch = Join-Path $repo ('.hermes/tmp/cloud paths ' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch
for ($subtype = 0; $subtype -le 15; $subtype++) {
    $tag = [uint32]([Convert]::ToUInt32('9000001A',16) + $subtype * 4096)
    Assert ([T3Paths.WindowsPathPolicy]::IsCloudTag($tag)) ('Cloud tag rejected: ' + $tag)
}
foreach ($value in @('A0000003','A000000C','9001001A','9000001C','80000015','00000000')) {
    Assert (-not [T3Paths.WindowsPathPolicy]::IsCloudTag([Convert]::ToUInt32($value,16))) ('Non-cloud tag accepted: ' + $value)
}
$outside = Join-Path $scratch 'outside fixture'
$guardRoot = Join-Path $scratch 'managed fixture'
$null = New-Item -ItemType Directory -Path $outside,$guardRoot
$ordinary = Join-Path $outside 'keep.txt'
[IO.File]::WriteAllText($ordinary, 'untouched external fixture')
$junction = Join-Path $guardRoot 'linked'
$null = New-Item -ItemType Junction -Path $junction -Target $outside
try {
    $rejected = $false
    try { $null = Assert-T3Child (Join-Path $junction 'keep.txt') $guardRoot } catch { $rejected = $_.Exception.Message.Contains('A0000003') }
    Assert $rejected 'Path guard allowed a real junction ancestor.'
    $rejected = $false
    try { Assert-T3Tree $guardRoot $scratch } catch { $rejected = $_.Exception.Message.Contains('A0000003') }
    Assert $rejected 'Managed tree guard allowed a real junction.'
    & dotnet run --project (Join-Path $repo 'tools/t3-launcher/T3Launcher.ContractTests') -- --cloud-paths $junction $ordinary
    Assert ($LASTEXITCODE -eq 0) 'Launcher shared path contract failed.'
} finally {
    $absoluteJunction = [IO.Path]::GetFullPath($junction)
    if (-not $absoluteJunction.StartsWith($scratch + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture junction removal escaped scratch.' }
    if ([T3Paths.WindowsPathPolicy]::GetReparseTag($absoluteJunction) -ne [Convert]::ToUInt32('A0000003',16)) { throw 'Fixture link changed before removal.' }
    # Remove only the link itself, never recursively remove its target.
    [IO.Directory]::Delete($absoluteJunction)
}
Assert ([IO.File]::ReadAllText($ordinary) -eq 'untouched external fixture') 'Junction target was modified.'

$source = Join-Path $scratch 'payload'
$destination = Join-Path $scratch 'OneDrive Desktop with spaces/TagTraceTrove'
$null = New-Item -ItemType Directory -Path $source
$files = [ordered]@{}
foreach ($name in @('Install.ps1','Install.cmd','lifecycle.ps1','WindowsPathPolicy.cs','Start.ps1','Start.cmd','Uninstall.ps1','Uninstall.cmd')) {
    Copy-Item -LiteralPath (Join-Path $repo ('tools/release/' + $name)) -Destination $source
    $files[$name] = (Get-FileHash -LiteralPath (Join-Path $source $name)).Hash.ToLowerInvariant()
}
[IO.File]::WriteAllText((Join-Path $source 'T3.exe'), 'never executed fixture')
$files['T3.exe'] = (Get-FileHash -LiteralPath (Join-Path $source 'T3.exe')).Hash.ToLowerInvariant()
function Manifest([string]$Version) {
    [IO.File]::WriteAllText((Join-Path $source 'release-manifest.json'), (@{ product='T3';platform='win-x64';version=$Version;files=$files } | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
Manifest '99.0.1'
& (Join-Path $source 'Install.ps1') -InstallRoot $destination -NoShortcut
Assert (Test-Path -LiteralPath (Join-Path $destination 'WindowsPathPolicy.cs')) 'Stable entry is missing the path helper.'
$data = Join-Path $destination 'data'
$null = New-Item -ItemType Directory -Path $data -Force
[IO.File]::WriteAllText((Join-Path $data 'keep.txt'), 'fixture user data')
Manifest '99.0.2'
& (Join-Path $source 'Install.ps1') -InstallRoot $destination -NoShortcut
Assert ([IO.File]::ReadAllText((Join-Path $data 'keep.txt')) -eq 'fixture user data') 'Update changed fixture data.'
$state = Get-Content -LiteralPath (Join-Path $destination 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert ($state.version -eq '99.0.2') 'Synthetic upgrade did not complete.'
$null = Read-T3Manifest $state.currentDirectory
Assert-T3Tree (Join-Path $destination 'versions') $destination
# This shipped uninstall only receives the explicitly verified scratch destination.
$uninstaller = Join-Path $destination 'Uninstall.ps1'
Assert ([IO.Path]::GetFullPath($uninstaller).StartsWith($scratch + '\', [StringComparison]::OrdinalIgnoreCase)) 'Fixture uninstall escaped scratch.'
& $uninstaller
Assert (-not (Test-Path -LiteralPath (Join-Path $destination 'versions'))) 'Synthetic program slots were not removed.'
Assert ([IO.File]::ReadAllText((Join-Path $data 'keep.txt')) -eq 'fixture user data') 'Uninstall changed retained fixture data.'
Write-Host ('PASS: PS5/native path metadata, all cloud subtypes, rejected junction/unknown tags, shared launcher policy, synthetic install/update/uninstall with retained data. Real OneDrive hydration unverified. Evidence: ' + $scratch)
