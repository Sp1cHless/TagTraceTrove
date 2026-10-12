"""Date fragments and labels shared by candidate generation and runtime extraction."""
from __future__ import annotations

import re
from datetime import date

# Non-capturing internally: a learned HTML filter wraps this as capture group 1.
DATE_TEXT = (r"(?<!\d)\d{4}(?:[-/.]|年)\d{1,2}(?:[-/.]|月)\d{1,2}日?"
             r"(?:[T \t]+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\d)")
DATE_RE = re.compile(DATE_TEXT)
_PARTS = re.compile(r"(\d{4})(?:[-/.]|年)(\d{1,2})(?:[-/.]|月)(\d{1,2})日?"
                    r"(?:[T \t]+(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?"
                    r"(?:Z|[+-](\d{2}):?(\d{2}))?)?")
LABELS = {
    "published": r"Posted(?:\s+on)?|Published(?:\s+(?:on|at|date))?|Uploaded(?:\s+(?:on|at))?"
                 r"|Release(?:\s+date|d)|Date\s+added|发布日期|发布时间|发布于|上传时间|投稿日|投稿日時",
    "updated": r"Last\s*updated|Updated(?:\s+(?:on|at))?|Modified(?:\s+(?:on|at))?"
               r"|更新时间|更新日期|修改时间|修改日期|更新于|更新日時",
    "created": r"Created(?:\s+(?:on|at))?|创建时间|创建日期|建立日期",
}
_LABEL_PATTERNS = {kind: re.compile(r"(?i)(?<![A-Za-z])(?P<label>" + label + r")"
                                  r"(?:\s*[:：]\s*|\s+)(?P<value>" + DATE_TEXT + r")")
                   for kind, label in LABELS.items()}


def valid_date(value: str) -> bool:
    match = _PARTS.fullmatch(value)
    if not match:
        return False
    year, month, day, hour, minute, second, offset_hour, offset_minute = match.groups()
    try:
        date(int(year), int(month), int(day))
    except ValueError:
        return False
    return ((hour is None or int(hour) < 24) and (minute is None or int(minute) < 60)
            and (second is None or int(second) < 60)
            and (offset_hour is None or int(offset_hour) < 24)
            and (offset_minute is None or int(offset_minute) < 60))


def extract_date(value: str) -> str:
    """Return one unambiguous valid date, preserving its time and explicit offset as written."""
    matches = list(DATE_RE.finditer(str(value)))
    if len(matches) != 1 or not valid_date(matches[0].group()):
        return ""
    return matches[0].group()


def labelled_dates(value: str):
    for kind, pattern in _LABEL_PATTERNS.items():
        for match in pattern.finditer(value):
            if valid_date(match.group("value")):
                yield kind, match.group("label"), match.group("value")


def labelled_filter(label: str) -> str:
    return (r"(?i)(?<![A-Za-z])" + re.escape(label)
            + r"(?:\s*[:：]\s*|\s+)(" + DATE_TEXT + ")")


def date_kind(key: str) -> str:
    key = re.sub(r"[^a-z]", "", key.lower())
    if any(part in key for part in ("published", "posted", "uploaded", "released", "uploaddate")):
        return "published"
    if any(part in key for part in ("modified", "updated")):
        return "updated"
    if "created" in key:
        return "created"
    return "unknown"
