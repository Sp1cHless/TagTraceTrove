-- Gallery partitions: a whole Entry type (Gallery) is either SFW or NSFW.
-- Individual Entries are never partitioned; tags of the two partitions do not
-- mix through visibility filters, and Authors inherit the partition of their
-- works (an Author with any work in an NSFW Gallery is an NSFW Author).
CREATE TABLE gallery_settings (
    entry_type TEXT NOT NULL PRIMARY KEY,
    nsfw INTEGER NOT NULL DEFAULT 0 CHECK (nsfw IN (0, 1))
);
