"""Write the mock site's pages and images (a C-phase walk fixture, not shipped code)."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent

WORKS = [
    ("1", "作品一", "作者甲", ["标签A", "标签B", "标签C"]),
    ("2", "作品二", "作者乙", ["标签B", "标签D"]),
    ("3", "作品三", "作者丙", ["标签A", "标签E"]),
]

PAGE = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>{title} - MockSite</title>
<meta property="og:title" content="{title}">
<meta property="og:image" content="http://127.0.0.1:8811/img/cover{index}.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><a href="/">MockSite 首页</a></header>
<main>
  <div class="breadcrumb"><a href="/list">作品列表</a></div>
  <h1 class="work-title">{title}</h1>
  <div class="work-meta">作者：<a class="author" href="/author/{author}">{author}</a></div>
  <div class="work-tags">标签：{tags}</div>
  <div class="cover-box"><img class="cover" src="/img/cover{index}.png" alt="{title}封面"></div>
  <p class="summary">{title}的简介段落。这一段是较长的自由文本，用来让标题字段不至于只能从 h1 读出。</p>
  <div class="ads">
    <img src="/img/ad1.png" alt="广告位">
    <img src="/img/ad2.png" alt="广告位">
  </div>
</main>
</body>
</html>
"""

colours = {"1": (206, 92, 92), "2": (92, 156, 206), "3": (120, 190, 120)}

for index, title, author, tags in WORKS:
    tag_html = "\n    ".join(
        f'<a class="tag" href="/tag/{tag}">{tag}</a>' for tag in tags
    )
    (ROOT / "work" / f"{index}.html").write_text(
        PAGE.format(title=title, author=author, tags=tag_html, index=index),
        encoding="utf-8",
    )
    Image.new("RGB", (240, 320), colours[index]).save(ROOT / "img" / f"cover{index}.png")

for name, colour in (("ad1", (230, 230, 230)), ("ad2", (200, 200, 200))):
    Image.new("RGB", (120, 90), colour).save(ROOT / "img" / f"{name}.png")

print("wrote", sorted(str(p.relative_to(ROOT)) for p in ROOT.rglob("*") if p.is_file()))
