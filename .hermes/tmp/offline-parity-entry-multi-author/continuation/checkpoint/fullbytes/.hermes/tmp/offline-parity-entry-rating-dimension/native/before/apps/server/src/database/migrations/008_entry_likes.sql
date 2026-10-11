-- Likes: personal unlimited re-clickable like counter per Entry, part of the
-- usage row (created lazily together with views). Author-side likes are
-- derived by summing their works' counters, never stored separately.
ALTER TABLE entry_usage
    ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0);
