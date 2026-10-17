-- A Gallery's card layout: the vertical wall it has always been, or the horizontal card — cover on
-- the left, the title on the right — for Galleries whose titles are long enough that a narrow
-- card reads badly (a paper's title is a sentence).
--
-- It lives on `gallery_settings` beside `nsfw`, because it is the same kind of thing: a choice that
-- belongs to the Gallery rather than to the view, so a person sets it once instead of every visit.
--
-- NOT synced to the phone, deliberately. `gallery_settings` travels in the sync snapshot and in the
-- `gallery_partition` journal, and both are strict schemas shared with an app that may already be
-- installed: an extra field there is not "an extra field" to an older client, it is a parse failure
-- on every row (the release freezes one web build into the APK, so the phone's schemas move only
-- when the app is updated). This column is therefore the desktop's own display choice — the phone
-- keeps its default — and `043`'s journal trigger, which watches `UPDATE OF nsfw`, already leaves it
-- out for the same reason: only `nsfw` moving is a partition revision.
ALTER TABLE gallery_settings
ADD COLUMN card_layout TEXT NOT NULL DEFAULT 'vertical'
CHECK (card_layout IN ('vertical', 'horizontal'));
