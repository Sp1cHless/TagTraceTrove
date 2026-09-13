from PIL import Image
import numpy as np, re, pathlib, urllib.request, hashlib

root = pathlib.Path('D:/Project/Dataextracted/site_probe/18comic_vip/exports/favorites_spechzy_folder_3401826/items/302092')
html = (root / 'raw.html').read_text(encoding='utf-8', errors='replace')
urls = re.findall(r'(?:src|data-src|data-original|background-image:\s*url\()[\'"]?([^\s\'")]+)', html)
hits = sorted({u for u in urls if '302092' in u})
print('--- distinct 302092 image urls in page ---')
for u in hits:
    print('  ', html.count(u), u)

def rescramble(im, num):
    if num == 0:
        return im
    W, H = im.size
    g, r = divmod(H, num)
    out = Image.new(im.mode, (W, H))
    for m in range(num):
        if m == 0:
            hh, sy, dy = g + r, H - (g + r), 0
        else:
            hh = g
            sy = H - g * (m + 1) - r
            dy = g * m + r
        out.paste(im.crop((0, sy, W, sy + hh)), (0, dy))
    return out

def fetch(url, name):
    p = pathlib.Path(name)
    if not p.exists():
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://18comic.vip/'})
        with urllib.request.urlopen(req, timeout=30) as r:
            p.write_bytes(r.read())
    return Image.open(p).convert('L')

cover = fetch('https://cdn-msp3.18comic.vip/media/albums/302092.jpg', 'cover.jpg')
print('cover size', cover.size, 'aspect', round(cover.size[1]/cover.size[0], 3))

def similarity(a, b):
    size = (160, 226)
    x = np.asarray(a.resize(size), dtype=np.float32)
    y = np.asarray(b.resize(size), dtype=np.float32)
    x = (x - x.mean()) / (x.std() + 1e-6)
    y = (y - y.mean()) / (y.std() + 1e-6)
    return float((x * y).mean())

for page in ['00001', '00002', '00003', '00029']:
    try:
        img = fetch(f'https://cdn-msp3.18comic.vip/media/photos/302092/{page}.webp', f'p{page}.webp')
    except Exception as e:
        print(page, 'fetch failed', e); continue
    scores = []
    for num in [0] + list(range(2, 21, 2)):
        scores.append((similarity(cover, rescramble(img, num)), num))
    scores.sort(reverse=True)
    print(f'page {page}: best={[(round(s,3), n) for s, n in scores[:4]]}')
