-- Chat by speaker (the 2026-10-07 plan audit): every read that names a speaker - the bank's
-- lines-said, reactions-given and reactions-received (chat.rs `lines_by`, `reactions_by`,
-- `reactions_to`), and the fold's take-back, edit and still-there lookups by a speaker's entry
-- hash - scanned the node's whole room lanes, because nothing led with `speaker_root`. One index
-- per table serves both shapes: the speaker alone is its prefix, the speaker and hash its key.
CREATE INDEX room_messages_by_speaker ON room_messages (speaker_root, entry_hash);
CREATE INDEX room_reactions_by_speaker ON room_reactions (speaker_root, entry_hash);
