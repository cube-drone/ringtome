//! Keeping big futures off the stack of the function that awaits them.
//!
//! A debug build gives each `async fn`'s poll a stack slot for every future it builds, never
//! sharing one between two awaits, so a function that awaits something big carries all of it in
//! its frame. On a deep path that adds up: a book's rollout ran a 2 MB worker stack to 1.89 MB -
//! the test beat's dispatch 618 KB, `books::rollout` 429 KB, `bake::publish_reporting` 375 KB -
//! and one more layer below overflowed it (2026-10-13, measured frame by frame). A release build
//! shares the slots; the desktop app's and `just start`'s debug builds don't.
//!
//! `Box::pin(f)` alone doesn't help: `f` is still built in the awaiting frame, then moved. Built
//! inside `boxed`'s own frame instead, the awaiting function holds a pointer. It takes the
//! future's own size off the caller's frame - not the frame the future's `poll` needs when it
//! runs, which is its own. What shrank the rollout's path (to 1.32 MB) was splitting the beat's
//! dispatch into a plain function returning each pass boxed (`test_endpoints::beat_pass`).
use std::future::Future;
use std::pin::Pin;

/// Build `make`'s future in this function's own frame, and box it: the caller's frame holds only
/// the box. For an await of a large future on a deep path.
#[inline(never)]
pub fn boxed<F: Future>(make: impl FnOnce() -> F) -> Pin<Box<F>> {
    Box::pin(make())
}
