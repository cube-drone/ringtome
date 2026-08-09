//! A sentence meant for a person, carried in a form the browser can translate.
//!
//! About a third of the words this application says are written here in Rust and displayed in
//! JavaScript: `net.js` lifts an error's `message` straight onto an `Error` and the UI renders it
//! unchanged. That makes every user-facing `AppError` interface copy, and interface copy has to be
//! translatable - which a bare `String` can never be, because by the time it crosses the wire the
//! English is already baked in.
//!
//! So a message travels as three things.
//!
//! `code` is the stable catalog key, minted once and never edited (see js/i18n.js for why a key
//! and the English both, rather than the English alone).
//!
//! `english` is already formatted: the fallback whenever the browser has no entry for the code,
//! which is every code until someone writes a translation, and any code they then miss.
//!
//! `params` are the values that filled the holes, kept SEPARATE so another language can put them
//! back in a different order. This is the part a pre-formatted string destroys, and word order is
//! the first thing that changes between languages.
//!
//! The browser translates once, in `net.js`, at the moment the error is built - so every existing
//! `setError(e.message)` display site keeps working and shows translated text without knowing that
//! anything changed.
//!
//! Build one with [`msg!`]:
//! ```ignore
//! msg!("auth.invalid-credentials", "invalid credentials")
//! msg!("auth.no-account", "no account \"{username}\"", username = req.username)
//! ```
use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;

/// A user-facing sentence: its catalog key, its English, and the values that fill its holes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserMessage {
    pub code: &'static str,
    pub english: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<&'static str, String>,
}

impl UserMessage {
    /// A sentence with no holes in it.
    pub fn plain(code: &'static str, english: impl Into<String>) -> Self {
        Self { code, english: english.into(), params: BTreeMap::new() }
    }

    /// A sentence whose holes have been filled, keeping the values for whoever re-fills them.
    pub fn with(
        code: &'static str,
        english: impl Into<String>,
        params: BTreeMap<&'static str, String>,
    ) -> Self {
        Self { code, english: english.into(), params }
    }
}

/// The English, which is what `thiserror`'s `#[error("{0}")]` and every log line want.
impl fmt::Display for UserMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.english)
    }
}

/// Build a [`UserMessage`]. The English is a literal so it can be lifted into the catalog by
/// `node/tools/strings.mjs`; named arguments are recorded as parameters as well as formatted, so
/// the browser can rebuild the sentence in its own word order.
///
/// Each named value is EVALUATED TWICE (once to format the English, once to record the parameter),
/// so arguments must be side-effect free. Every call site passes a field, a constant or simple
/// arithmetic, which is the only shape this needs to serve. Both uses borrow, so nothing is moved
/// out of the caller.
///
/// Binding the values to locals first would be the obvious way to evaluate them once, and it is a
/// trap: an ALL-CAPS argument name like `USERNAME_MIN` is read by `let` as a constant PATTERN
/// rather than as a new binding, so the macro stops compiling at exactly the call sites that name
/// a constant.
#[macro_export]
macro_rules! msg {
    ($code:expr, $english:expr) => {
        $crate::message::UserMessage::plain($code, $english)
    };
    ($code:expr, $english:expr, $($name:ident = $value:expr),+ $(,)?) => {{
        let mut params = std::collections::BTreeMap::new();
        $(params.insert(stringify!($name), $value.to_string());)+
        $crate::message::UserMessage::with($code, format!($english, $($name = $value),+), params)
    }};
}
