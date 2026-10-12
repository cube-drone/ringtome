-- hrseAmp's memo of the sound in posts (amp.rs, plans/AUDIO.md): which documents are the sound a
-- post carries - itself, for a sound posted alone; its embedded twins, for one in a written post -
-- with what the library shows of each, read once from the author's database per version of the
-- post, so a reader's library never opens one database per person it holds music from.
--   post_updated_ms  the post's version this was read at; a newer one is read again
--   sound_doc        '' for a post read and found to carry no sound after all
CREATE TABLE amp_sounds (
    author_root      TEXT    NOT NULL,
    post_doc         TEXT    NOT NULL,
    sound_doc        TEXT    NOT NULL,
    post_updated_ms  INTEGER NOT NULL,
    title            TEXT    NOT NULL DEFAULT '',
    duration_ms      INTEGER,
    has_thumb        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (author_root, post_doc, sound_doc)
);
