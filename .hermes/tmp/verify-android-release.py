import hashlib, json, pathlib, subprocess, zipfile

root = pathlib.Path(__file__).resolve().parents[2]
shell = root / 'spikes/001-android-webview-shell'
apk = shell / 'T3-1.0.0.apk'
public = shell / 'android/app/src/main/assets/public'
build_tools = shell / '.android-sdk/build-tools/36.0.0'
badging = subprocess.check_output([str(build_tools / 'aapt.exe'), 'dump', 'badging', str(apk)], encoding='utf-8')
assert "name='com.speechless666.t3.spike' versionCode='100' versionName='1.0.0'" in badging
assert "application-label:'T3'" in badging
assert 'application-debuggable' not in badging
signature = subprocess.check_output([str(build_tools / 'apksigner.bat'), 'verify', '--verbose', '--print-certs', str(apk)], encoding='utf-8')
assert 'CN=T3 Android Release' in signature
assert 'CN=Android Debug' not in signature
signer = next(line.split(': ', 1)[1] for line in signature.splitlines() if 'certificate SHA-256 digest:' in line)
files = {}
with zipfile.ZipFile(apk) as archive:
    packaged = {name.removeprefix('assets/public/') for name in archive.namelist() if name.startswith('assets/public/') and not name.endswith('/')}
    expected = {p.relative_to(public).as_posix() for p in public.rglob('*') if p.is_file()}
    assert packaged == expected
    for name in sorted(expected):
        data = archive.read('assets/public/' + name)
        assert data == (public / name).read_bytes(), name
        files[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
    bundle = next(name for name in expected if name.startswith('assets/index-') and name.endswith('.js'))
    data = archive.read('assets/public/' + bundle)
    assert b'1.0.0' in data and b'0.0.49-c3-offline-parity-r25' not in data
    config = json.loads(archive.read('assets/capacitor.config.json'))
    assert config['appName'] == 'T3' and config['loggingBehavior'] == 'debug'
    assert not config.get('android', {}).get('webContentsDebuggingEnabled', False)
manifest = {'artifact': str(apk.relative_to(root)), 'applicationId': 'com.speechless666.t3.spike', 'label': 'T3', 'versionCode': 100, 'versionName': '1.0.0', 'debuggable': False, 'diagnosticBuild': '1.0.0', 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'signerCertSha256': signer, 'bundle': bundle, 'packagedWebFiles': files, 'installed': False, 'oldDebugSignatureCompatible': False}
(root / '.hermes/artifacts/android-release-1.0.0.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({k: manifest[k] for k in ['versionName','versionCode','debuggable','apkSha256','signerCertSha256','bundle']}, ensure_ascii=True))
print('Verified APK signature, release identity and ' + str(len(files)) + ' packaged Web files.')
