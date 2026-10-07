-- Three lookups by a key no index led with (the 2026-10-07 plan audit), each a scan of a node-wide
-- table where a seek was meant:
--
-- - The notification refresh's standing rows for one author and kind (notifications.rs), under
--   the primary key `(reader_root, …)`.
-- - A held room's author by its doc (chat.rs `room_author_of`), which the sync serve gate asks for
--   every room instance a peer names; `room_messages_by_room` leads with the author.
-- - A hosted room's author on the shelf by its doc (nodeshelf.rs `room_author`), under the
--   primary key `(author_root, …)`: partial, rooms posted here only, the predicate the read
--   names.
CREATE INDEX notifications_by_author ON notifications (author_root, kind);
CREATE INDEX room_messages_by_doc ON room_messages (room_doc);
CREATE INDEX node_shelf_rooms ON node_shelf (doc_id) WHERE format = 'room' AND via_root = '';
