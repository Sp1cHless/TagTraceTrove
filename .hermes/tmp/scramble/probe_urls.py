import hashlib, pathlib, urllib.request, urllib.error
disk = pathlib.Path('D:/Project/Dataextracted/site_probe/18comic_vip/exports/favorites_spechzy_folder_3401826/items/302092/previews/00029.webp').read_bytes()
print('disk sha256', hashlib.sha256(disk).hexdigest()[:16], len(disk), 'bytes')
UA_PY = 'python-urllib/3.11'
UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
candidates = [
    'https://cdn-msp3.18comic.vip/media/photos/302092/00029.webp',
    'https://cdn-msp3.18comic.vip/media/photos/302092/00029.jpg',
    'https://cdn-msp3.18comic.vip/media/photos/302092/00029.png',
    'https://cdn-msp3.18comic.vip/media/albums/302092.jpg',
]
for url in candidates:
    for label, ua in [('py', UA_PY), ('chrome', UA_CHROME)]:
        req = urllib.request.Request(url, headers={'User-Agent': ua, 'Referer': 'https://18comic.vip/'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
                print(f'{label:6s} {r.status} {len(data):9d} {hashlib.sha256(data).hexdigest()[:16]} {r.headers.get("content-type")} {url[-40:]}'
                      + ('  <== IDENTICAL TO DISK' if hashlib.sha256(data).hexdigest() == hashlib.sha256(disk).hexdigest() else ''))
                pathlib.Path(f'dl-{url.split("/")[-1]}-{label}').write_bytes(data)
        except urllib.error.HTTPError as e:
            print(f'{label:6s} HTTP {e.code} {url[-40:]}')
        except Exception as e:
            print(f'{label:6s} ERR {type(e).__name__} {e} {url[-40:]}')
