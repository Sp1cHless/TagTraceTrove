from PIL import Image
import hashlib, pathlib

SCRAMBLE_ID = 220980
AID = 302092
SRC = pathlib.Path('D:/Project/Dataextracted/site_probe/18comic_vip/exports/favorites_spechzy_folder_3401826/items/302092/previews')

def get_num(aid: int, filename: str, scramble_id: int = SCRAMBLE_ID) -> int:
    # JMComic reference: no scramble below the threshold, fixed 10 in the middle band, md5 after that
    if aid < scramble_id:
        return 0
    if aid < 268850:
        return 10
    digest = hashlib.md5(f'{aid}{filename}'.encode()).hexdigest()
    num = ord(digest[-1]) % (10 if aid < 421926 else 8)
    return num * 2 + 2

def descramble(im, num):
    W, H = im.size
    g, r = divmod(H, num)
    out = Image.new(im.mode, (W, H))
    for m in range(num):
        if m == 0:
            h, sy, dy = g + r, H - (g + r), 0
        else:
            h = g
            sy = H - g * (m + 1) - r
            dy = g * m + r
        out.paste(im.crop((0, sy, W, sy + h)), (0, dy))
        y = dy + h
    assert y == H, y
    return out

for name in ['00029', '00003', '00055']:
    img = Image.open(SRC / f'{name}.webp').convert('RGB')
    num = get_num(AID, f'{name}.webp')
    print(name, 'size', img.size, 'strips', num)
    fixed = descramble(img, num)
    fixed.thumbnail((620, 6000))
    fixed.save(f'fixed-{name}.png')
