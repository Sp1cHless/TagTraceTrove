param(
    [string]$SigningDirectory = (Join-Path $env:USERPROFILE '.t3\signing'),
    [string]$KeytoolPath = (Join-Path $env:JAVA_HOME 'bin\keytool.exe')
)
$ErrorActionPreference = 'Stop'
$keyPath = Join-Path $SigningDirectory 'android-release.p12'
$propertiesPath = Join-Path $SigningDirectory 'android-release.properties'
if ((Test-Path -LiteralPath $keyPath) -or (Test-Path -LiteralPath $propertiesPath)) {
    throw 'Signing files already exist. Restore/reuse them; never regenerate the signing identity for an update.'
}
if (-not (Test-Path -LiteralPath $KeytoolPath -PathType Leaf)) { throw 'Set JAVA_HOME to a JDK or pass -KeytoolPath.' }
New-Item -ItemType Directory -Path $SigningDirectory -Force | Out-Null
$secretBytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($secretBytes) } finally { $generator.Dispose() }
$env:T3_KEY_INIT_PASSWORD = [Convert]::ToBase64String($secretBytes)
try {
    & $KeytoolPath -genkeypair -alias t3-release -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -dname 'CN=T3 Android Release' -storetype PKCS12 -keystore $keyPath -storepass:env T3_KEY_INIT_PASSWORD -keypass:env T3_KEY_INIT_PASSWORD -noprompt
    if ($LASTEXITCODE -ne 0) { throw 'Key generation failed; retain any generated file and inspect it before retrying.' }
    $properties = @(
        ('storeFile=' + $keyPath.Replace('\', '/')),
        ('storePassword=' + $env:T3_KEY_INIT_PASSWORD),
        'keyAlias=t3-release',
        ('keyPassword=' + $env:T3_KEY_INIT_PASSWORD)
    )
    [IO.File]::WriteAllLines($propertiesPath, $properties, [Text.UTF8Encoding]::new($false))
    Write-Output ('Created private signing files in ' + $SigningDirectory + '. Back up both files securely; do not publish them.')
} finally {
    Remove-Item Env:T3_KEY_INIT_PASSWORD -ErrorAction SilentlyContinue
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
}
