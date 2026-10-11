-- Producer rating values share the Producer revision so online edits are visible to
-- the same conflict/journal boundary used by offline Producer operations. Keep
-- this as a database trigger: HTTP, imports, and future writers all participate.
CREATE TRIGGER producer_rating_values_sync_insert
AFTER INSERT ON producer_rating_values
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = NEW.producer_id;
END;

CREATE TRIGGER producer_rating_values_sync_update
AFTER UPDATE OF stars ON producer_rating_values
WHEN OLD.stars IS NOT NEW.stars
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = NEW.producer_id;
END;

CREATE TRIGGER producer_rating_values_sync_delete
AFTER DELETE ON producer_rating_values
BEGIN
  UPDATE producers SET updated_at = updated_at WHERE id = OLD.producer_id;
END;
