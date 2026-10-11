from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parents[2]
spike = root / 'spikes/001-android-webview-shell'
apk = spike / 'T3-C1-v36-pending-authors.apk'
shutil.copy2(spike / 'android/app/build/outputs/apk/debug/app-debug.apk', apk)
web = spike / 'web-dist'
checked = []
combined = b''
with zipfile.ZipFile(apk) as bundle:
    for source in sorted(web.rglob('*')):
        if not source.is_file():
            continue
        relative = source.relative_to(web).as_posix()
        actual = bundle.read('assets/public/' + relative)
        assert actual == source.read_bytes(), f'Bundled bytes differ: {relative}'
        if relative.startswith('assets/'):
            assert actual == (root / 'apps/web/dist' / relative).read_bytes(), relative
        combined += actual
        checked.append(relative)
    for marker in [b'0.0.36-c1-pending-authors', b'offlinePendingEntryAuthors', b'entry.authors.set', b'pending-author-form']:
        assert marker in combined, f'Missing marker: {marker!r}'
env = dict(os.environ, JAVA_HOME=r'C:\Program Files\Eclipse Adoptium\jdk-21.0.7.6-hotspot')
build = spike / '.android-sdk/build-tools/36.0.0'
certs = []
for candidate in [apk, spike / 'T3-C1-v35-pending-tags.apk']:
    result = subprocess.run([str(build / 'apksigner.bat'), 'verify', '--verbose', '--print-certs', str(candidate)],
                            env=env, capture_output=True, text=True, check=True)
    cert = next(line for line in result.stdout.splitlines() if 'certificate SHA-256 digest:' in line)
    certs.append(cert)
    if candidate == apk:
        (root / '.hermes/artifacts/v36-signer.log').write_text(result.stdout, encoding='utf8')
assert certs[0] == certs[1], 'Signer mismatch'
result = subprocess.run([str(build / 'aapt.exe'), 'dump', 'badging', str(apk)], capture_output=True, text=True, check=True)
package = next(line for line in result.stdout.splitlines() if line.startswith('package:'))
assert "versionCode='36'" in package and "versionName='0.0.36-c1-pending-authors'" in package, package
report = {'apk': str(apk), 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'size': apk.stat().st_size,
          'matchedWebFiles': checked, 'markersVerified': True, 'sameSignerAsV35': True, 'package': package}
print(json.dumps(report, indent=2))
(root / '.hermes/artifacts/v36-apk-byte-verification.json').write_text(json.dumps(report, indent=2), encoding='utf8')
