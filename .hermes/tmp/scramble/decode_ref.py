from PIL import Image
from jmcomic import JmImageTool
import pathlib, numpy as np

SRC = pathlib.Path('D:/Project/Dataextracted/site_probe/18comic_vip/exports/favorites_spechzy_folder_3401826/items/302092/previews')
SCRAMBLE_ID = 220980

for name in ['00029', '00003', '00055']:
    url = f'https://cdn-msp3.18comic.vip/media/photos/302092/{name}.webp'
    num = JmImageTool.get_num_by_url(SCRAMBLE_ID, url)
    for variant in [f'{name}', f'{name}.webp']:
        alt = JmImageTool.get_num(SCRAMBLE_ID, 302092, variant)
        print(f'  filename={variant!r} -> num={alt}')
    print(f'{name}: num (per jmcomic get_num_by_url) = {num}')
    img = Image.open(SRC / f'{name}.webp').convert('RGB')
    out = pathlib.Path(f'ref-{name}.png')
    JmImageTool.decode_and_save(num, img, str(out))
    a = np.asarray(Image.open(out).convert('L'), dtype=np.float32)
    print(f'   decoded shape={a.shape} top6={a[:6].mean():6.1f} bot6={a[-6:].mean():6.1f} top30={a[:30].mean():6.1f} bot30={a[-30:].mean():6.1f}')
    small = Image.open(out).convert('RGB'); small.thumbnail((620, 6000)); small.save(f'ref-{name}-small.png')
