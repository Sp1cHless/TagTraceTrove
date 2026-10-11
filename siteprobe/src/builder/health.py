"""Phase 7 尾段（计划 §10 的 maintenance 那一半）：规则失效时点名，并给出候选替换。

计划对这件事的要求很明确：adaptive matching 只能是辅助 ✓；**不得默认静默修改正式
adapter** ✓；最终仍要落成确定性 selector/path ✓。所以这个模块只**报告**：

* 每个字段是否读到值（读不到的字段就是"规则失效"的现场 ✓）；
* 对读不到的字段，给出同一页上的**候选替换**（来自 Builder 的候选采集 ✓，每条都带它自己的
  确定性规则 ✓）——够人一眼判断"是不是改版了、该换成哪个" ✗，但不会写进任何文件 ✓。

它不依赖 Scrapling ✗（§10 要求先评估，评估结论已记在执行记录里 ✓）：候选来自已有的
harvest ✓，所以这里没有任何新的匹配算法，只有"读一次、点名、给候选"。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..generic import declarative
from ..generic.bundle import RawItem
from ..generic.document import DocumentBag
from ..generic.extract import build_bag, extract_work
from ..generic.select import resolve
from ..generic.template import load_template

# The fields a work's record carries, and which of them a person would notice going missing.
# `cover` is nested, the categories live under one key — the same shape `extract_work` writes.
RECORD_FIELDS = ("title", "author", "date_added", "page_count", "language_name",
                 "cover", "tags", "previews")


@dataclass
class Finding:
    """One field of an adapter, and what reading it produced."""

    field: str
    document: str
    rule: dict[str, Any]
    read: Any
    suggestions: list[dict[str, Any]] = field(default_factory=list)

    @property
    def broken(self) -> bool:
        return self.read in (None, "", [], {})

    def to_json(self) -> dict[str, Any]:
        return {"field": self.field, "document": self.document, "rule": self.rule,
                "read": self.read, "broken": self.broken, "suggestions": self.suggestions}


def _value_in_record(record: dict[str, Any], field_name: str) -> Any:
    if field_name == "cover":
        return (record.get("cover") or {}).get("url")
    if field_name == "tags":
        return (record.get("分类信息") or {}).get("分类标签")
    if field_name == "previews":
        return record.get("preview_images")
    return record.get(field_name)


def check_work_adapter(template_path: Path, url: str, html: str) -> list[Finding]:
    """Read one page with an installed adapter and report every field that came back empty.

    Reading through the runtime's own path — `declarative.documents_from` and `extract_work`, the
    same two calls an installed adapter makes — because a check that models the reader instead of
    using it is a check of something else.
    """
    template = load_template(template_path)
    item_texts = dict(declarative.documents_from(template, html))
    item = RawItem(source_id="health", target_url=url)
    for name, text in item_texts.items():
        item.add(name, text)
    bag = build_bag(template, item)
    record = extract_work(template, item)

    findings: list[Finding] = []
    for field_name, rule in (template.raw.get("work", {}).get("fields") or {}).items():
        try:
            value = resolve(rule, bag, context={"url": url})
        except Exception:  # noqa: BLE001 - a rule that cannot run reads nothing
            value = None
        findings.append(Finding(field=field_name,
                                document=str(rule.get("document") or "page"),
                                rule=rule, read=value))
    for name in RECORD_FIELDS:
        if name in {finding.field for finding in findings}:
            continue
        value = _value_in_record(record, name)
        findings.append(Finding(field=name, document="(record)", rule={}, read=value))
    return findings


def suggestions_for(html: str, url: str, *, limit: int = 5,
                    like: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """The page's own candidates as replacement rules, for a person to choose from.

    The Builder's harvester, unchanged: every candidate carries the rule that reads it again, so
    a suggestion is a *deterministic* selector rather than an adaptive match — which is what the
    plan asks a repaired adapter to end up as.

    `like` is the rule that stopped working, and it decides which candidates are worth showing:
    a text rule wants text values, a link rule wants addresses. Measured on a real album page:
    without that, the first forty candidates by score were the navigation's own links and a
    library index, and the title — which the page does carry, under `#book-name` — was nowhere in
    the list a person was shown.
    """
    from .capture import Capture, plain_documents
    from .harvest import harvest

    capture = Capture(url=url, final_url=url)
    capture.status = 200
    capture.content_type = "text/html"
    capture.documents = plain_documents(html)
    result = harvest(capture)
    wants: tuple[str, ...] | None = None
    if like:
        if like.get("attr") or like.get("absolute"):
            wants = ("url", "image")
        elif like.get("text"):
            wants = ("text", "collection")
    out: list[dict[str, Any]] = []
    for candidate in result.candidates:
        if wants and candidate.kind not in wants:
            continue
        rule = next((source.rule for source in candidate.sources if source.rule), None)
        if rule is None:
            continue
        out.append({"value": str(candidate.value)[:80], "kind": candidate.kind,
                    "score": candidate.score, "rule": rule})
        if len(out) >= limit:
            break
    return out


def describe(findings: list[Finding]) -> str:
    """A one-screen report: what read nothing, and what the page offers instead."""
    broken = [finding for finding in findings if finding.broken]
    lines = [f"{len(findings) - len(broken)}/{len(findings)} field(s) read a value"]
    for finding in findings:
        mark = "empty" if finding.broken else "ok   "
        shown = json.dumps(finding.read, ensure_ascii=False)
        lines.append(f"    {mark} {finding.field:12} {shown[:64]}")
    if broken:
        lines.append("")
        lines.append("the page's own candidates, as replacement rules:")
        for finding in broken[:6]:
            for suggestion in finding.suggestions[:2]:
                lines.append(f"    for {finding.field:12} {suggestion['value'][:44]!r} "
                             f"{json.dumps(suggestion['rule'], ensure_ascii=False)[:78]}")
    return "\n".join(lines)
