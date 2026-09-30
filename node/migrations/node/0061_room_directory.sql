-- The rooms' recent speakers, as this node has been told them (2026-09-29, Curtis: a newcomer to a
-- room whose creator's node is dark "would need... the chat history, which they don't have" to
-- know whom to ask; "just keeping track of the last 20-50 people to post in a room should be loads
-- for anybody to get bootstrapped"). Filled from every room directory answer, whoever gave it -
-- the creator's node, a speaker's, a sharer's - and capped at the fifty most recently heard per
-- room. `heard_ms` orders them: newest speaker first, as the answer listed them. `endpoints` is
-- where the answering node said each speaker is served (comma-separated endpoint ids): a speaker
-- this node holds no key tree for can't be found from their root alone.
CREATE TABLE room_directory (
    room_author  TEXT    NOT NULL,
    room_doc     TEXT    NOT NULL,
    speaker_root TEXT    NOT NULL,
    heard_ms     INTEGER NOT NULL,
    endpoints    TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (room_author, room_doc, speaker_root)
);
