from PIL import Image
import numpy as np, itertools, json, sys

paths = {
 '00029': 'D:/Project/Dataextracted/site_probe/18comic_vip/exports/favorites_spechzy_folder_3401826/items/302092/previews/00029.webp',
 '00003': 'D:/Project/Dataextracted/site_probe/18comic_vip/exports/favorites_spechzy_folder_3401826/items/302092/previews/00003.webp',
}
K = 8

def strips_of(im, s):
    H = im.shape[0]
    g = H // s
    out = []
    for m in range(s):
        y0, y1 = g*m, (H if m == s-1 else g*(m+1))
        out.append(im[y0:y1])
    return out

def cost_matrix(parts):
    s = len(parts)
    c = np.zeros((s, s), dtype=np.float64)
    for i in range(s):
        bottom = parts[i][-K:].astype(np.float32)
        # normalize contrast per strip pair
        for j in range(s):
            if i == j:
                c[i, j] = 1e9
                continue
            top = parts[j][:K].astype(np.float32)
            c[i, j] = np.abs(bottom - top).mean()
    return c

def best_path(c):
    s = len(c)
    INF = 1e18
    dp = np.full((1 << s, s), INF)
    par = np.full((1 << s, s), -1, dtype=np.int64)
    for i in range(s):
        dp[1 << i, i] = 0.0
    for mask in range(1 << s):
        for i in range(s):
            if dp[mask, i] >= INF: continue
            base = dp[mask, i]
            for j in range(s):
                if mask >> j & 1: continue
                nm = mask | (1 << j)
                v = base + c[i, j]
                if v < dp[nm, j]:
                    dp[nm, j] = v
                    par[nm, j] = i
    full = (1 << s) - 1
    end = int(np.argmin(dp[full]))
    order = []
    mask = full
    cur = end
    while cur != -1:
        order.append(cur)
        p = par[mask, cur]
        mask ^= (1 << cur)
        cur = int(p)
    order.reverse()
    return order, float(dp[full, end] / (s - 1))

for name, path in paths.items():
    im = np.asarray(Image.open(path).convert('L'), dtype=np.float32)
    print('###', name, im.shape)
    rd = np.abs(np.diff(im, axis=0)).mean(axis=1)
    peaks = np.argsort(rd)[-14:][::-1]
    print('  strongest horizontal discontinuities (row, diff):',
          [(int(p), round(float(rd[p]), 1)) for p in sorted(peaks)])
    for s in [2, 3, 4, 5, 6, 8, 10, 12, 16, 18]:
        parts = strips_of(im, s)
        c = cost_matrix(parts)
        order, cost = best_path(c) if s <= 16 else (list(range(s)), float('nan'))
        if s > 16:
            print(f'  s={s:2d} skipped (too many)'); continue
        ident = float(np.mean([c[i, i+1] for i in range(s-1)]))
        rev = float(np.mean([c[s-1-i, s-2-i] for i in range(s-1)]))
        print(f'  s={s:2d} best={cost:7.2f} identity={ident:7.2f} reverse={rev:7.2f} order(after best)={order}')
