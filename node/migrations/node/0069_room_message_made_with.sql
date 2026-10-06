-- What a chat line was made with (plans/MCP.md, _Provenance_; chat.rs, 2026-10-06): the line's
-- own signed `made_with` - "ai-agent" or "api-key" - or nothing for a line a person typed. Set if
-- the line or any edit of it carried one, never cleared. No backfill: no line said before this
-- rung could carry the field.
ALTER TABLE room_messages ADD COLUMN made_with TEXT;
