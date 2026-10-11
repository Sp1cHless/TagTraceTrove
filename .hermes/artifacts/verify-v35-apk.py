from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[2]
spike = root / 'spikes/001-android-webview-shell'
apk = spike / 'T3-C1-v35-pending-tags.apk'
web = spike / 'web-dist'
with zipfile.ZipFile(apk) as bundle:
    checked = []
    combined = b''
    for source in sorted(web.rglob('*')):
        if not source.is_file():
            continue
        relative = source.relative_to(web).as_posix()
        actual = bundle.read('assets/public/' + relative)
        assert actual == source.read_bytes(), f'Bundled bytes differ: {relative}'
        combined += actual
        checked.append(relative)
    for marker in [b'0.0.35-c1-pending-tags', b'offlinePendingEntryTags', b'entry.tags.set']:
        assert marker in combined, f'Missing marker: {marker!r}'
report = {'apk': str(apk), 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'size': apk.stat().st_size, 'matchedWebFiles': checked, 'markersVerified': True}
print(json.dumps(report, indent=2))
(root / '.hermes/artifacts/v35-apk-byte-verification.json').write_text(json.dumps(report, indent=2), encoding='utf8')
