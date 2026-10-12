import hashlib, json, pathlib, zipfile, sys

root = pathlib.Path(__file__).resolve().parents[3]
shell = root / 'spikes/001-android-webview-shell'
release = int(sys.argv[1]) if len(sys.argv) > 1 else 20
marker = f'0.0.49-c3-offline-parity-r{release}'
apk = shell / f'T3-v49-offline-final-state-r{release}.apk'
public = shell / 'android/app/src/main/assets/public'
files = {}
with zipfile.ZipFile(apk) as archive:
    packaged = {n.removeprefix('assets/public/') for n in archive.namelist() if n.startswith('assets/public/') and not n.endswith('/')}
    expected = {p.relative_to(public).as_posix() for p in public.rglob('*') if p.is_file()}
    assert packaged == expected, (packaged - expected, expected - packaged)
    for relative in sorted(expected):
        data = archive.read('assets/public/' + relative)
        assert data == (public / relative).read_bytes(), relative
        files[relative] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
    bundle = next(n for n in expected if n.startswith('assets/index-') and n.endswith('.js'))
    data = archive.read('assets/public/' + bundle)
    assert marker.encode() in data
    assert f'0.0.49-c3-offline-parity-r{release - 1}'.encode() not in data
manifest = {'artifact': str(apk.relative_to(root)), 'versionCode': 49, 'versionName': '0.0.49-c3-offline-parity', 'diagnosticBuild': marker, 'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'signerCertSha256': '1035333c6fa6a18e40398739adda5a2640e6c9cf38e94bea1bf58118eb5fdf41', 'packagedWebManifest': {'files': files}, 'bundle': bundle}
target = root / f'.hermes/tmp/offline-takeover/release-v49/manifest-r{release}.json'
target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'verifiedFiles': len(files), 'bundle': bundle, 'apkSha256': manifest['apkSha256']}, ensure_ascii=False))
