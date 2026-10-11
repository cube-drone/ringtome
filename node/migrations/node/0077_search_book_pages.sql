-- A book is searched by its pages' words (2026-10-10, Curtis: "banana", on a page of his book, found
-- nothing): its bag in the index used to hold its title alone, since a book's own body is only its
-- table. `pages` says a book's bag carries its pages; one that doesn't is read again when a search
-- next meets it as a book, and nothing else is read again.
ALTER TABLE post_search ADD COLUMN pages INTEGER NOT NULL DEFAULT 0;
