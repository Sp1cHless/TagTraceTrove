from PIL import Image
import numpy as np, hashlib, pathlib, hashlib as h

SRC = pathlib.Path('D:/Project/Dataextracted/site_probe/18comic_vip/exports/favorites_spechzy_folder_3401826/items/302092/previews')
AID = 302092
for name in ['00029', '00003', '00055']:
    d = h.md5(f'{AID}{name}.webp'.encode()).hexdigest()
    print(name, 'md5', d, 'last', d[-1], 'ord%10', ord(d[-1]) % 10, 'num', ord(d[-1]) % 10 * 2 + 2)

def num_of(name):
    d = h.md5(f'{AID}{name}.webp'.encode()).hexdigest()
    return ord(d[-1]) % (10 if AID < 421926 else 8) * 2 + 2

def rescramble(im, num):
    """reverse strip order (same op both ways) with remainder on the first output strip"""
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

im = np.asarray(Image.open(SRC / '00029.webp').convert('L'), dtype=np.float32)
def score(a):
    H = a.shape[0]
    border = (a < 128)
    # panel borders: vertical dark lines should continue across seams
    def colmask(row):
        return border[row]
    s = 0.0
    # margin check: top/bottom rows nearly white
    for num in range(2, 21, 2):
        g, r = divmod(H, num)
        seams = []
        for m in range(1, num):
            y = g * m + r if m > 0 else 0
            if y >= H: continue
            a1, a2 = colmask(y - 1), colmask(y)
            seams.append(np.mean(a1 == a2))
        top_white = a[:6].mean()
        bot_white = a[-6:].mean()
        print(f'  num={num:2d} bordermatch={np.mean(seams):.3f} topwhite={top_white:6.1f} botwhite={bot_white:6.1f}')
print('--- border continuation over candidate strip counts (raw strips in order) ---')
score(im)
print()
print('--- after reversal, margins per num ---')
for num in range(2, 21, 2):
    f = np.asarray(rescramble(Image.open(SRC / '00029.webp').convert('L'), num), dtype=np.float32)
    print(f'  num={num:2d} top6={f[:6].mean():6.1f} bot6={f[-6:].mean():6.1f} top30={f[:30].mean():6.1f} bot30={f[-30:].mean():6.1f}')
