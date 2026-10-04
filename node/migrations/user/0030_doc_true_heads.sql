-- The true head set (2026-10-03): every version no other version of the document names as a
-- parent, sorted, concatenated 32-byte hashes. `logical_heads` counts what a person sees - folded
-- twins and ancestor echoes collapsed - but a save must parent on every TRUE head, and opening a
-- document for editing (`docs_get_handler`) needs them; without them it rebuilt the document's
-- whole history to learn them, so an often-saved note opened slower the longer it lived. NULL is
-- "not memoized yet": such a document takes the full path, and its row fills on its next change.
ALTER TABLE doc_heads ADD COLUMN true_heads BLOB;
