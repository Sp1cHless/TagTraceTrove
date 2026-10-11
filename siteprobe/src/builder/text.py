"""Every word the annotation page shows, in each language it offers.

The page is served by the tool but read by a person who is *inside T³*, so its language is not the
tool's choice: T³ passes the language its own interface is in (`SITEPROBE_LANG`) and the page renders
whole in that one. That replaces a Chinese page whose title, kind chips, picture names and buttons
stayed English — mixed in one screen, which is what the user asked to end ("目前只有中文版，而且里面
混杂了英语").

Two rules hold the split:

* **The tool's own vocabulary stays untranslated where it is *evidence*** — the provenance channels
  (`markup:h1 text`, `jsonld`, `network:0`) are how a rule is diagnosed, and the candidate kinds
  (`text`, `image`, `collection`) are what the filter chips select on. The *labels* a person reads are
  translated; the values a rule is written against are not.
* **One table per language, no fallbacks between them.** A missing key is a bug the tests catch
  (`test_every_word_the_page_shows_exists_in_both_languages`), not something to paper over at runtime.
"""

from __future__ import annotations

import os
from typing import Mapping

LANGS: tuple[str, ...] = ("zh", "en")
DEFAULT_LANG = "zh"

#: The language T³ is in. Anything unknown falls back to the default rather than raising: a page in
#: the wrong language is a nuisance, a page that cannot render is a dead run.
ENV_LANG = "SITEPROBE_LANG"


def lang_from_env(environ: Mapping[str, str] | None = None) -> str:
    value = (environ or os.environ).get(ENV_LANG, "").strip().lower()
    return value if value in LANGS else DEFAULT_LANG


#: `{name}` placeholders are filled by the page (`fill(T.key, {...})`), never by Python, so a
#: translated sentence can put them in its own order.
CHROME: dict[str, dict[str, str]] = {
    "docTitle": {"zh": "SiteProbe 标注", "en": "SiteProbe annotation"},
    "pickHint": {
        "zh": "先点左侧字段，再点右侧候选即可指派。",
        "en": "Click a field on the left, then a value on the right, to assign it.",
    },
    "noRuleHint": {
        "zh": "候选列表里没有的值无法在此选择——那需要手写规则或补一个采集通道。",
        "en": "A value that is not in the list cannot be chosen here — that needs a written rule, "
              "or another channel that harvests it.",
    },
    "save": {"zh": "保存标注", "en": "Save annotation"},
    "saveNote": {
        "zh": "没标任何东西的字段不会被记录；「本作品没有这项」也是有效答案。",
        "en": "Fields you leave alone are not recorded; \u201cthis work has no such value\u201d is an "
              "answer too.",
    },
    "needField": {"zh": "先选一个左侧字段。", "en": "Pick a field on the left first."},
    "searchPlaceholder": {
        "zh": "搜索候选的值或来源",
        "en": "Search a value or where it came from",
    },
    "kindAll": {"zh": "全部", "en": "All"},
    "unassigned": {"zh": "未指派", "en": "Not set"},
    "absentValue": {
        "zh": "（本作品没有这项，不记录）",
        "en": "(no such value on this work — not recorded)",
    },
    "absentButton": {"zh": "— 本作品没有这项", "en": "— This work has none"},
    "accept": {"zh": "✓ 对", "en": "✓ Right"},
    "reject": {"zh": "✗ 错，我来选", "en": "✗ Wrong — I will pick"},
    "unreadable": {"zh": "(读不到值)", "en": "(read nothing)"},
    "openPicture": {"zh": "打开图片", "en": "Open the picture"},
    "pictureFailed": {"zh": "图片无法加载", "en": "the picture did not load"},
    "source": {"zh": "来源", "en": "source"},
    "sourceCount": {"zh": "{count} 项", "en": "{count} items"},
    "sourceOpen": {"zh": "（点开看出处）", "en": "(open to see where)"},
    "ambiguous": {
        "zh": "· 规则会匹配多个元素，需验证",
        "en": "· the rule matches several elements — needs checking",
    },
    "noMatches": {"zh": "没有匹配的候选。", "en": "No candidate matches."},
    # A field holding several members says how many: `标签A / 标签B（2 项）`.
    "counted": {"zh": "（{count} 项）", "en": " ({count} items)"},
    "tooMany": {
        "zh": "共 {count} 条候选，这里只列出前 {max} 条（用搜索或类型筛选缩小范围）。",
        "en": "{count} candidates — the first {max} are listed here (narrow it with the search box "
              "or a kind).",
    },
    "submitting": {"zh": "提交中…", "en": "Submitting…"},
    "saveFailed": {"zh": "保存失败：{error}", "en": "Saving failed: {error}"},
    # The wait after a page is submitted: the tool now captures the next site with a headless
    # browser — several seconds, up to a minute — and only then opens its page. That is where the
    # person has to stay, so it is the page's headline and it sits in the middle of the screen; a
    # line under the save button is where the eye is not. `savedNext`/`savedLast` are the detail
    # lines underneath it.
    "waitHeadline": {"zh": "正在打开下一个网站…", "en": "Opening the next site…"},
    "doneHeadline": {"zh": "全部完成，请回到 T³", "en": "All done — go back to T³"},
    "savedNext": {
        "zh": "已保存：{fields}。下一个适配器会套用你标注的规则，并预选它读到的值——有错的就改正，"
              "全部正确就继续看下一个网页。",
        "en": "Saved: {fields}. The next adapter applies the rules you marked and pre-selects what "
              "it reads — correct anything wrong, and continue when all of it is right.",
    },
    # A page can be submitted with nothing marked (every proposal rejected), and "已保存：。" is not a
    # sentence. It says so instead, because the person is about to see a next page with no proposals.
    "savedNothing": {
        "zh": "（这次没有记录任何字段）",
        "en": "(nothing was recorded this time)",
    },
    "savedLast": {
        "zh": "适配器已经存储完毕，回到 T³ 界面继续即可。",
        "en": "The adapter is stored — go back to T³ to continue.",
    },
    # Pictures are named by score order, the same name on every page, and the field column answers
    # with it — so the name has to exist in both languages.
    "picture": {"zh": "图片{order}", "en": "Image {order}"},
    # The fallback when a picture arrived without a name (a candidate from a channel that names
    # nothing), so the row is never blank.
    "pictureBare": {"zh": "图片", "en": "Image"},
    "siteOf": {"zh": "第{cn}个网站（{index}/{total}）", "en": "Site {index} of {total}"},
}

#: The candidate kinds, as a person reads them on the filter chips. The *value* a chip selects on
#: stays the tool's (`text`, `image`, …); this is only the label.
KIND_LABELS: dict[str, dict[str, str]] = {
    "text": {"zh": "文本", "en": "Text"},
    "number": {"zh": "数字", "en": "Number"},
    "url": {"zh": "地址", "en": "URL"},
    "image": {"zh": "图片", "en": "Image"},
    "images": {"zh": "图组", "en": "Image set"},
    "collection": {"zh": "合集", "en": "Group"},
}

#: A field's name in the left column. The keys are the annotation's own field names.
FIELD_LABELS: dict[str, dict[str, str]] = {
    "title": {"zh": "作品标题", "en": "Title"},
    "creator": {"zh": "作者 / 创作者", "en": "Author / creator"},
    "date": {"zh": "日期", "en": "Date"},
    "description": {"zh": "简介", "en": "Synopsis"},
    "cover": {"zh": "封面", "en": "Cover"},
    "preview": {"zh": "预览图", "en": "Preview pictures"},
    "tags": {"zh": "分类标签", "en": "Tags"},
    "characters": {"zh": "登场人物", "en": "Characters"},
    "series": {"zh": "作品系列", "en": "Series"},
    # a listing card's fields, under the runtime's own names
    "source_id": {"zh": "作品 id", "en": "Work id"},
    "cover_url": {"zh": "封面", "en": "Cover"},
    "date_added": {"zh": "日期", "en": "Date"},
    "author": {"zh": "作者 / 社团", "en": "Author / circle"},
}

#: What each field is asking for, in the page's own words rather than the schema's.
FIELD_HINTS: dict[str, dict[str, str]] = {
    "title": {"zh": "点页面上的作品标题", "en": "Click the work's title on the page"},
    "creator": {"zh": "点作者 / 创作者的名字", "en": "Click the author's name"},
    "date": {"zh": "点发布日期", "en": "Click the release date"},
    "description": {
        "zh": "点简介正文（会作为条目正文导入）",
        "en": "Click the synopsis text (it is imported as the Entry's Content)",
    },
    "cover": {
        "zh": "点封面图，或它在页面上的图片地址",
        "en": "Click the cover picture, or its address on the page",
    },
    "preview": {
        "zh": "点整组预览图那一项（图组，右侧写着有几张；只保留前 {limit} 张，本作品没有预览图就不用点）",
        "en": "Click the whole preview set (an image set; the right-hand list says how many) — only "
              "the first {limit} are kept, and a work with no previews needs nothing here",
    },
    "tags": {
        "zh": "点一个分类标签，或整段标签（多位值会自动按逗号 / 空格拆开）",
        "en": "Click one tag, or the whole tag block (several values are split by comma or space)",
    },
    "characters": {
        "zh": "点一个登场人物，或整段人物（同上，会拆成多位）",
        "en": "Click one character, or the whole cast block (split the same way)",
    },
    "series": {"zh": "点作品系列 / 所属作品", "en": "Click the series the work belongs to"},
    "source_id": {
        "zh": "必填：点这张卡上通往作品的链接，编号会从链接里取出来",
        "en": "Required: click the card's link to the work — the id is read out of the address",
    },
    "cover_url": {"zh": "点卡片上的封面图", "en": "Click the card's cover picture"},
    "date_added": {
        "zh": "点卡片上的日期；列表页常常不显示日期，没有就留空",
        "en": "Click the card's date — a listing often shows none, and then this stays empty",
    },
    "author": {"zh": "点卡片上的作者 / 社团", "en": "Click the card's author or circle"},
}

#: The tips the page shows instead of the harvest's log notes (the C specification). One list per
#: language, so the page and any future surface teach the same three.
TIPS: dict[str, tuple[str, ...]] = {
    "zh": (
        "保持原网页打开，多复制粘贴：直接复制原网页的内容（作者名、标题、tag），"
        "在搜索框里搜索，就会弹出相应的内容，选择最匹配的。",
        "核心原则：选择最匹配的信息！适配器会打分给出最可能的候选，但最匹配的才是重要的。"
        "\"$作者S$\"、\"123标题456\" 这类像代码的值可能被打高分，"
        "但只要纯净的字段显示在网页上，适配器就一定抓得到——一定要找最匹配的！",
        "多字段组合：适配器可能同时抓到 \"作者S，作者H\" 和分开的 \"作者S\"、\"作者H\"，"
        "要选择包含最多的选项。tag 也是如此。",
    ),
    "en": (
        "Keep the page open and copy freely: copy a value straight off it (an author, a title, a "
        "tag), paste it into the search box, and pick the closest match.",
        "The core rule: pick the best-matching value. The tool scores candidates, but the score is "
        "not the point — values like \"$authorS$\" or \"123title456\" look like page code and can "
        "score high, while the clean value, if the page shows it, was certainly harvested too. "
        "Always take the best match.",
        "Combined values: the tool may harvest \"authorS, authorH\" as one candidate and also "
        "\"authorS\" and \"authorH\" separately — pick the one that holds the most. The same goes "
        "for tags.",
    ),
}

#: The **card** page's tips. The three above are about finding a value among one page's candidates;
#: a listing card is a different job — the card is one sample of a set, and what is marked on it
#: becomes the rule for every card in the set (the C specification's 列表适配器 half).
LISTING_TIPS: dict[str, tuple[str, ...]] = {
    "zh": (
        "列表适配器会打开该列表，并把它找到的作品都展示出来；请选一个作参考——"
        "挑你能真正打开的那个，一般第一个就行。",
        "有的网站登录与不登录看到的数量不同（例如登录时 30 条、不登录只有 20 条）；"
        "这种情况仍然需要单独适配。",
        "你进入的是该作品在列表里能看到的那些信息，所以比作品适配器时看到的少。不用担心："
        "真正录入时依旧按之前适配的全信息录入。",
        "选对信息最关键：这一步要从列表的一堆杂乱信息里正确认出一个个作品，"
        "并定位它的基本信息（封面、标题等）。",
    ),
    "en": (
        "The listing adapter opens the listing and shows every work it found there; pick one as the "
        "reference — the one you can actually open, usually the first.",
        "Some sites show a different number of results signed in than signed out (30 against 20, "
        "say); that case still needs an adapter of its own.",
        "What you enter is the work's information as the listing shows it, so less than the work "
        "adapter saw. Nothing is lost: the import still uses the full information.",
        "Picking the right value is what matters here: telling one work from another in a listing's "
        "clutter, and locating its basics — the cover, the title.",
    ),
}

#: The card page's own words where they differ from the work page's chrome. A card is the whole
#: annotation for its adapter — there is no next page to move to — so the completion line is the one
#: the page shows once it is submitted (`savedLast`), and nothing here promises a following page.
LISTING_CHROME: dict[str, dict[str, str]] = {
    "saveNote": {
        "zh": "这张卡片就是列表适配标注的全部：保存后适配器由工具自己装好。",
        "en": "The card is the whole annotation for a listing adapter: saving it is the last step.",
    },
    "savedLast": {
        "zh": "保存完成，适配器已经存储完毕，请回到 T³ 界面继续。",
        "en": "Saved — the adapter is stored. Go back to T³ to continue.",
    },
}

#: The card chooser (`session_server.CHOOSER_TEMPLATE`), which is part of the same flow. It reuses
#: the chrome keys whose words are the same (`openPicture`, `pictureFailed`, `submitting`,
#: `saveFailed`) and adds only what is its own.
CHOOSER: dict[str, dict[str, str]] = {
    "docTitle": {"zh": "SiteProbe - 哪一张是作品卡片", "en": "SiteProbe — which card is the work"},
    "count": {
        "zh": "这是工具在这一页找到的 {count} 张卡片。点你认为是“一个作品”的那一张"
              "——它会被当作这一组卡片的代表，规则也从它学起。",
        "en": "These are the {count} cards the tool found on this page. Click the one you consider "
              "a work — it stands for the set, and the rule is learned from it.",
    },
    "use": {"zh": "用这张", "en": "Use this card"},
    # Same wait, one step earlier: the card is chosen, the tool now harvests that card and opens its
    # annotation page. It says "a moment" rather than naming a card, because what the person has to
    # do is wait — the page that matters is the next one.
    "waitHeadline": {"zh": "正在打开这张卡片的标注页…", "en": "Opening the card's annotation page…"},
    "chosen": {
        "zh": "已选择 {index} 号卡片。",
        "en": "Card {index} chosen.",
    },
}

#: The annotation page's chrome keys the chooser page reads too, because the words are the same.
#: Enumerated rather than "the whole chrome": what a page is handed should be what it reads.
CHOOSER_REUSES: tuple[str, ...] = ("pictureFailed", "saveFailed", "submitting")


def chooser(lang: str) -> dict[str, str]:
    """Everything the *card chooser* page reads, in one language.

    Its own page, its own words — feeding it the annotation page's chrome is how it once arrived
    with no `count` at all: the script died on the first line that read one and what a person saw
    was a blank page with a single URL on it. `tests/test_session_server.py` now holds the payload
    against the keys the template actually reads, so a page cannot go out half-fed again.
    """
    chosen = lang if lang in LANGS else DEFAULT_LANG
    words = {key: CHROME[key][chosen] for key in CHOOSER_REUSES if key in CHROME}
    return {**words, **{key: values[chosen] for key, values in CHOOSER.items()}}


#: Fragments the *harvester* writes into a candidate's provenance line, which the page then shows
#: folded away under 来源. They are built while harvesting, so the language is read there.
PROVENANCE: dict[str, dict[str, str]] = {
    # `div.previews img (4 张图)` — the selector, then how many members it read.
    "members": {"zh": "{selector}（{count} 项）", "en": "{selector} ({count} values)"},
    "pictures": {"zh": "{selector}（{count} 张图）", "en": "{selector} ({count} pictures)"},
    # The same set shifted by one: a cover taken from a run of pictures, with the preview in the
    # pictures after it. Says so, because otherwise it reads as a duplicate of the line above.
    "picturesAfter": {
        "zh": "{selector}（第 1 张之后的 {count} 张图）",
        "en": "{selector} (the {count} pictures after the first)",
    },
    "row": {
        "zh": "{detail}，取自标签为 {label!r} 的那一行",
        "en": "{detail}, captured from the row labelled {label!r}",
    },
    "jsonKey": {"zh": "{key}", "en": "{key}"},
}


def provenance(kind: str, lang: str, **values: object) -> str:
    chosen = lang if lang in LANGS else DEFAULT_LANG
    template = PROVENANCE[kind][chosen]
    for name, value in values.items():
        template = template.replace("{" + name + "}", str(value))
    return template


#: `第{cn}` in Chinese needs the numeral as a character; English just uses the digit.
CN_NUM: tuple[str, ...] = ("一", "二", "三", "四", "五", "六", "七", "八", "九", "十")


def chrome(lang: str) -> dict[str, str]:
    """Every chrome string of the page, in one language, for the payload."""
    chosen = lang if lang in LANGS else DEFAULT_LANG
    return {key: values[chosen] for key, values in CHROME.items()}


def chrome_for(vocabulary: str, lang: str) -> dict[str, str]:
    """The page's words for the vocabulary it is showing (a work's, or a listing card's)."""
    words = chrome(lang)
    if vocabulary != "listing":
        return words
    chosen = lang if lang in LANGS else DEFAULT_LANG
    return {**words, **{key: values[chosen] for key, values in LISTING_CHROME.items()}}


def tips_for(vocabulary: str, lang: str) -> tuple[str, ...]:
    """The tips the page teaches with — the card page has four of its own."""
    chosen = lang if lang in LANGS else DEFAULT_LANG
    return (LISTING_TIPS if vocabulary == "listing" else TIPS)[chosen]


def kind_labels(lang: str) -> dict[str, str]:
    chosen = lang if lang in LANGS else DEFAULT_LANG
    return {kind: values[chosen] for kind, values in KIND_LABELS.items()}


def field_label(lang: str, field: str, fallback: str) -> str:
    chosen = lang if lang in LANGS else DEFAULT_LANG
    return FIELD_LABELS.get(field, {}).get(chosen, fallback)


def field_hint(lang: str, field: str, *, limit: int | None = None) -> str:
    chosen = lang if lang in LANGS else DEFAULT_LANG
    text = FIELD_HINTS.get(field, {}).get(chosen, "")
    return text.replace("{limit}", str(limit)) if limit is not None else text


def tips(lang: str) -> tuple[str, ...]:
    return TIPS[lang if lang in LANGS else DEFAULT_LANG]


def picture_name(lang: str, order: int) -> str:
    return CHROME["picture"][lang if lang in LANGS else DEFAULT_LANG].replace("{order}", str(order))


def position_text(lang: str, index: int, total: int) -> str:
    """`第一个网站（1/3）` in Chinese, `Site 1 of 3` in English."""
    chosen = lang if lang in LANGS else DEFAULT_LANG
    numerals = CN_NUM[index] if 0 <= index < len(CN_NUM) else str(index + 1)
    return (CHROME["siteOf"][chosen]
            .replace("{cn}", numerals)
            .replace("{index}", str(index + 1))
            .replace("{total}", str(total)))
