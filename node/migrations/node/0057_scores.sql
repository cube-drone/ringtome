-- Scores, stored and kept incrementally (PROJECT_PLAN's Scores and sort orders, Shape, 2026-09-27):
-- the cost of a reader's "best" orders paid as reactions and dial changes arrive, not by every page.
-- All three are derivable from the label memo and the reader's dials (score.rs `rebuild`).

-- The dials the stored scores were reckoned with, per reader: for each person they drew an edge
-- to, what that person's reaction weighs (thousandths - 0.25 is 250) and, as an author, the
-- interest factor on their posts (x1.1 is 1100). A dial moved is found by diffing against this, and
-- only what it touched is rescored. Absent is a stranger: weight 0, factor 1000.
CREATE TABLE score_dials (
    reader_root   TEXT    NOT NULL,
    root          TEXT    NOT NULL,
    weight_milli  INTEGER NOT NULL,
    factor_milli  INTEGER NOT NULL,
    PRIMARY KEY (reader_root, root)
);
-- A reaction arriving asks which readers weigh its sayer.
CREATE INDEX score_dials_by_root ON score_dials (root, reader_root);

-- One person's contribution to one post, for one reader: their reactions' tones summed, times
-- their weight. Kept so a reaction or a dial moves one part, not the whole sum. Zero parts are
-- not kept.
CREATE TABLE score_parts (
    reader_root  TEXT    NOT NULL,
    author_root  TEXT    NOT NULL,
    doc_id       TEXT    NOT NULL,
    annotator    TEXT    NOT NULL,
    part_milli   INTEGER NOT NULL,
    PRIMARY KEY (reader_root, author_root, doc_id, annotator)
);
CREATE INDEX score_parts_by_annotator ON score_parts (reader_root, annotator);
CREATE INDEX score_parts_by_author ON score_parts (reader_root, author_root);

-- A post's score for one reader, in thousandths: its parts summed, times the reader's interest in
-- its author. Zero scores are not kept - a post nobody the reader weighs reacted to is simply absent.
CREATE TABLE post_scores (
    reader_root  TEXT    NOT NULL,
    author_root  TEXT    NOT NULL,
    doc_id       TEXT    NOT NULL,
    milli        INTEGER NOT NULL,
    PRIMARY KEY (reader_root, author_root, doc_id)
);
CREATE INDEX post_scores_by_score ON post_scores (reader_root, milli);
