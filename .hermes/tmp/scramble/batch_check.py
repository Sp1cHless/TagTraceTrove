from PIL import Image
from jmcomic import JmImageTool
import pathlib, numpy as np, random

ROOT = pathlib.Path('D:/Project/Dataextracted/site_probe/18comic_vip/exports')
SCRAMBLE_ID = 220980
files = sorted([p for p in ROOT.glob('*/items/*/previews/*.webp')])
print('total preview files:', len(files))
random.seed(7)
sample = random.sample(files, 60)

def margins(a):
    return a[:6].mean(), a[-6:].mean()

def descramble(img, num):
    if num == 0:
        return img
    w, h = img.size
    out = Image.new('RGB', (w, h))
    over = h % num
    import math
    for i in range(num):
        move = math.floor(h / num)
        y_src = h - move * (i + 1) - over
        y_dst = move * i
        if i == 0:
            move += over
        else:
            y_dst += over
        out.paste(img.crop((0, y_src, w, y_src + move)), (0, y_dst))
    return out

def url_of(p):
    # exports/<folder>/items/<aid>/previews/<name>.webp
    aid = p.parent.parent.name
    return f'https://cdn-msp3.18comic.vip/media/photos/{aid}/{p.name}', int(aid)

before = after = 0
nums = {}
fails = []
for p in sample:
    url, aid = url_of(p)
    img = Image.open(p).convert('RGB')
    num = JmImageTool.get_num_by_url(SCRAMBLE_ID, url)
    nums[num] = nums.get(num, 0) + 1
    a0 = np.asarray(img.convert('L'), dtype=np.float32)
    t0, b0 = margins(a0)
    if t0 > 250 and b0 > 245: before += 1
    a1 = np.asarray(descramble(img, num).convert('L'), dtype=np.float32)
    t1, b1 = margins(a1)
    if t1 > 250 and b1 > 245: after += 1
    else: fails.append((aid, p.name, num, round(t1,1), round(b1,1), round(t0,1), round(b0,1)))
print('num distribution:', dict(sorted(nums.items())))
print(f'white-margin page ratio BEFORE: {before}/{len(sample)}   AFTER: {after}/{len(sample)}')
print('still-not-white after:', len(fails))
for f in fails[:12]: print('   aid=%s %s num=%s top=%s bot=%s (was %s/%s)' % f)
