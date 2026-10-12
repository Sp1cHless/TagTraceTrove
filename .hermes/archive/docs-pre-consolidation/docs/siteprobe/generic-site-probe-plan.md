# Generic site_probe: plan and feasibility

Status: **proposal only, nothing implemented.** Task 1 (work ids + update cursors) is done and is the first prerequisite this plan builds on.

The question this answers: can "fetch a page's information" and "crawl pages and save them" be separated, with the saving half generic, so that adding a site means only describing how that site stores its information?

**Yes.** The generic half already exists. What is missing is a declarative front half.

## What is already generic

`commit.ts` is completely site-agnostic. `commitImportBatch(database, batch, mapping)` takes a canonical `ImportBatch` plus a reviewed `ImportCommitMapping` and knows nothing about hitomi, 18comic or hanime1. Every site-specific assumption lives in `site-probe.ts`, which holds three hand-written item schemas and three hand-written adapters (`adaptComicItem`, `adaptHanimeItem`, `adaptHitomiItem`).

That is where the asymmetry the user noticed comes from. `adaptHitomiItem` sets `contentTypes: item.分类信息.作品类型 ?? []`, while `adaptComicItem` omits the key entirely. Nothing structural forces this. `ImportEntry.fields` is `z.record(z.string(), z.unknown())`, and `commit.ts` already requires every *present* field to be mapped or ignored — so a site that has no work-type field simply produces no `contentTypes` key and nothing breaks. The hardcoding is an artifact of writing one adapter per site, not a model limitation.

The second piece of reusable machinery is stronger than it first looks. `source-maintenance/adapters/template-html.ts` defines `HtmlSearchTemplate` — row-split regex, per-row url/title/cover patterns, fail-closed counter checks, rate limits — with per-site fixtures under `tests/fixtures/source-maintenance/generic/<host>/`. On top of it, `adapters/generic-html.ts` already implements **blind, rule-free discovery**: it parses the homepage's own `<form>` to find the search endpoint, takes the probe keyword from the homepage's longest title-looking link so the probe is on-topic in any language, then does **differential extraction** — search once with the probe and once with a nonce, group anchors by URL signature, and keep the group present under the probe but absent under the nonce. That difference *is* the result list, whatever the markup. `generic-discover-cli.ts` runs it against arbitrary homepages and saves the raw pages as replayable fixtures.

So the codebase already contains a working general engine for the listing half, proved against a set of real sites. This plan applies the same "config plus fixtures, no per-site code" shape to work *metadata*, and treats the differential idea as a technique to extend rather than invent.

## What the split looks like

| Concern | Where it lives | Generic? |
|---|---|---|
| Reaching the site, pacing, anti-bot, pagination | the crawler (outside T³) | partly — see risks |
| Deciding which field means what on a page | a per-site template in T³ | no, one config per site |
| Turning a page into an `ImportEntry` | one generic resolver in T³ | yes |
| Persisting Entries, tags, producers, ids, cursors | `commit.ts` + `site-crawl-repository.ts` | yes |

Fetching deliberately stays outside T³. Two reasons: the guardrails forbid web-wide crawling inside the product, and T³ has no HTTP client, no SSRF surface, and no headless browser to add one. The crawler stays a **dumb fetcher** that dumps raw documents per URL; T³ owns the interpretation. That is the cleanest reading of the user's own split, and it keeps the per-site knowledge versioned, fixtured and tested in this repo where it can be reviewed.

## The template shape

One declarative object per site, mirroring `HtmlSearchTemplate`:

```ts
interface SiteProbeTemplate {
  key: string;                      // '18comic.vip'
  displayName: string;
  hosts: string[];
  /** How a listing enumerates its works. Only the kinds a site has. */
  listings: Partial<Record<'artist' | 'folder' | 'work' | 'search', ListingRule>>;
  /** How one work's fields are read out of its raw document. */
  work: Record<string, FieldRule>;
  rateLimit: { concurrency: number; minDelayMs: number };
  headers?: Record<string, string>;
}
```

`work` keys are exactly `ImportEntry`'s vocabulary — `title`, `cover`, `previews`, `uploadDate`, `pageCount`, `tags`, `works`, `characters`, `authors`, `contentTypes`, `language` — and a `FieldRule` says where that field comes from in the raw document:

```ts
type FieldRule =
  | { source: 'json'; path: string; transform?: Transform }
  | { source: 'html'; pattern: RegExp; group?: number; transform?: Transform }
  | { source: 'url'; pattern: RegExp; group?: number }
  | { source: 'const'; value: string }
  | { source: 'document'; field: string };   // the crawler already normalized it
```

`source: 'document'` is the compatibility bridge: it accepts today's export shape unchanged, so the hitomi/18comic/hanime exports keep working while the rest of the template is filled in. `source: 'json'` matters because hitomi's real metadata comes from its own JSON endpoint, not from HTML — a regex-only template could not express it. `transform` is a small closed set (`trim`, `dateOnly`, `splitList`, `stripHtml`, `absoluteUrl`), not a formula language.

Three properties make this the "tolerant" pipeline the user asked for:

- A rule that matches nothing produces **no key**. There is no per-site placeholder, so "18comic has no work type" stops being a special case and becomes an absent key.
- A field the template cannot express is simply absent from the config, and the existing reviewed-mapping step already handles absent fields.
- Auto-mapping by normalized Facet name (`作品`→Series, `登场人物`→Characters, `作品语言`→Language) already exists in the web review, so a template can additionally declare a preferred Facet name per field and the review opens pre-filled instead of blank. Producer mapping stays user-directed, per the guardrails.

## Staged path

1. **Template layer + resolver + `18comic` re-expressed as a template**, with the three legacy item schemas left in place as a fallback. Acceptance: the existing `tests/import/site-probe-import.test.ts` expectations pass unchanged against the template path, proving parity rather than asserting new behavior.
2. **Convert hitomi and hanime, then delete the hand-written adapters.** At that point `site-probe.ts` is a registry lookup, and adding a site is a config object plus fixtures. The hitomi manifest shape (a list of ids, one bad folder not blocking the rest, per-work error naming) is already handled generically and stays.
3. **Add the raw-document reader**: a template variant that reads the crawler's raw HTML/JSON dumps instead of the pre-normalized export. This is the step that makes the crawler fully generic — after it, the crawler contains no per-site code at all, only a URL list and a dump loop.
4. **Task 3, optional and independent**: a `--from-url` reader for one page with *no* template, using generic extraction only. Scope: cover, title, date, author, and opportunistic tags.

A note on stage 3 and `ListingRule`: the differential-extraction trick may make even the listing rule unnecessary for search-shaped listings, since `discoverHtmlSearch` already proves it can find a result list with no site knowledge. The open question worth answering during stage 1 is whether the same differential move extends to a *work page's fields* — for instance by diffing a work page against a sibling work page to isolate the fields that vary (title, cover, date, tags) from the boilerplate that does not. If it works, it is a strictly better generic extractor than per-field regex guessing; if it does not, the template carries the load. This is the one part of the design that should be prototyped before committing to it.

## Task 3: one URL, no template

This is a separate, much smaller piece and does not need stages 1–3. The technique is well established and should not be invented from scratch: Open Graph (`og:title`, `og:image`, `article:published_time`) plus JSON-LD (`schema.org` `ComicStory` / `Book` / `Movie` / `CreativeWork`) plus a few HTML fallbacks (`<title>`, `<time datetime>`, `<meta name="author">`). `extruct`/`trafilatura` (Python) and `metascraper` (Node) are the reference implementations.

Recommendation: hand-write a bounded reader rather than add `metascraper`'s dependency tree. `jsdom` is already a dependency, the repo already has a licence to read and decode a page (`decodeHtmlEntities`, the template row splitter), and the wanted result is deliberately small — a cover, a name, a date, an author, and "tags if it went well". A useful estimate: ~150 lines plus tests, versus a dependency tree the project has otherwise kept to zod/hono/jsdom/sharp/better-sqlite3.

Honest expectation for task 3: it will produce a usable cover + title + date + author on a large share of pages and nothing on JS-rendered or login-walled ones. It should report confidence and what it could not find rather than guessing, and it should never *write* without the existing review step.

## Where generality breaks down

These are the parts that stay per-site research, matching the user's own guess:

1. **Listing and pagination.** A *search-shaped* listing is already handled generically by `discoverHtmlSearch`, with no per-site rules at all. What is not covered is enumerating a listing that no search query backs — an artist's or a folder's complete work list, its page-N URL, and knowing when the listing has been fully read. Hand-written, or a declarative rule when the site is plain HTML.
2. **Anti-bot gates.** The fixture set already contains nonce-cookie pages (`60ti.com-nonce.html`, `kanman.com-nonce.html`), so this is a known, encountered problem rather than a hypothetical one. Solving it belongs in the crawler.
3. **JS-rendered sites.** If the server HTML contains no data, no template can help; that class needs a headless browser and is out of scope. Worth stating explicitly so a site that "does not work" is diagnosed correctly rather than blamed on the template.
4. **Semantic ambiguity across sites.** Two sites' `tags` do not mean the same thing. A template can declare a preferred Facet name; it cannot guarantee the result is meaningful. That stays a review-time judgement, which is already how tags work.
5. **Dates.** Many sites have no reliable upload date. Task 1's cursor already handles this by falling back to id ordering, and by the exact `filter` set-difference when neither is trustworthy.

## Effort

- Stage 1 (template layer, resolver, 18comic parity, fixtures, tests): the bulk of the work.
- Stage 2 (hitomi + hanime conversion, deleting the old adapters): moderate, mostly mechanical once stage 1 proves the shape.
- Stage 3 (raw-document reader): moderate, and it is the step that pays off the crawler simplification.
- Each additional site afterwards: a small config object plus captured fixtures.
- Task 3 standalone reader: small.

## Tooling note

Researching a new site's storage shape — which is the genuinely irreducible per-site step — is much faster with a browser actually driven against the page than by reading HTML blind. That is a one-time investigation per site, and the delivered artifact is the fixture plus the template, both of which live in the repo.
