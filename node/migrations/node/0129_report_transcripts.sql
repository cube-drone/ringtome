-- A chat line's report (plans/MODERATION.md, _A chat line_; 2026-11-27): the room and the line it
-- names, and the hash of the transcript the reporter's node uploads after the envelope. A sealed
-- room's key arrives in the envelope and is held here only until the transcript does - an hour at
-- most - then set to NULL; what stays is the opened lines, as JSON (reports.rs `take_transcript`).
ALTER TABLE reports ADD COLUMN room_author TEXT;
ALTER TABLE reports ADD COLUMN room_doc TEXT;
ALTER TABLE reports ADD COLUMN room_line TEXT;
ALTER TABLE reports ADD COLUMN room_sealed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN room_key BLOB;
ALTER TABLE reports ADD COLUMN transcript_hash TEXT;
ALTER TABLE reports ADD COLUMN transcript TEXT;
