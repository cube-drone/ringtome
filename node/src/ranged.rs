//! Byte ranges on the routes that serve a document's body (Curtis, 2026-10-11: a sound opened in
//! Files sometimes played "a file that gets longer as it goes"). A browser learns an Ogg file's
//! length by reading its last page, and seeks by asking for the bytes it wants - both through
//! `Range` requests. A node that never answered one left the `<audio>` element knowing only what it
//! had played so far, and unable to seek past what it had fetched.
//!
//! A body is decrypted whole before it is served, so a range is a slice of bytes already in hand:
//! [`apply`] takes the finished answer and the request's `Range`, and cuts it. One range only - a
//! multipart answer is for clients we don't have; anything it can't read is answered whole, as
//! RFC 9110 allows.

use axum::body::Body;
use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;

/// What a `Range` header asks of a body `len` bytes long.
#[derive(Debug, PartialEq, Eq)]
pub enum Span {
    /// No range, or one this doesn't read: the whole body.
    Whole,
    /// These bytes, first to last inclusive.
    Part(u64, u64),
    /// A range that starts past the end.
    Unsatisfiable,
}

/// Read a `Range` header against a body `len` bytes long: `bytes=a-b`, `bytes=a-`, `bytes=-n`.
pub fn span(range: Option<&str>, len: u64) -> Span {
    let Some(spec) = range.and_then(|r| r.trim().strip_prefix("bytes=")) else {
        return Span::Whole;
    };
    if spec.contains(',') {
        return Span::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else { return Span::Whole };
    let (first, last) = (first.trim(), last.trim());
    if first.is_empty() {
        // The last n bytes.
        let Ok(n) = last.parse::<u64>() else { return Span::Whole };
        if n == 0 || len == 0 {
            return Span::Unsatisfiable;
        }
        return Span::Part(len.saturating_sub(n), len - 1);
    }
    let Ok(a) = first.parse::<u64>() else { return Span::Whole };
    if a >= len {
        return Span::Unsatisfiable;
    }
    let b = if last.is_empty() {
        len - 1
    } else {
        match last.parse::<u64>() {
            Ok(b) if b >= a => b.min(len - 1),
            _ => return Span::Whole,
        }
    };
    Span::Part(a, b)
}

/// The request's `Range`, as text.
pub fn requested(headers: &HeaderMap) -> Option<String> {
    headers.get(axum::http::header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// A body's answer, cut to the request's range: `206` with the slice, `416` for a range past the
/// end, and every whole answer saying it may be asked for in parts. Anything but a `200` (a `304`,
/// an error) passes as it is.
pub async fn apply(range: Option<&str>, response: Response) -> Response {
    if response.status() != StatusCode::OK {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if range.is_none() {
        return Response::from_parts(parts, body);
    }
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return Response::from_parts(parts, Body::empty());
    };
    let len = bytes.len() as u64;
    match span(range, len) {
        Span::Whole => Response::from_parts(parts, Body::from(bytes)),
        Span::Part(a, b) => {
            parts.status = StatusCode::PARTIAL_CONTENT;
            set(&mut parts.headers, CONTENT_RANGE, format!("bytes {a}-{b}/{len}"));
            set(&mut parts.headers, CONTENT_LENGTH, (b - a + 1).to_string());
            Response::from_parts(parts, Body::from(bytes.slice(a as usize..=b as usize)))
        }
        Span::Unsatisfiable => {
            parts.status = StatusCode::RANGE_NOT_SATISFIABLE;
            set(&mut parts.headers, CONTENT_RANGE, format!("bytes */{len}"));
            parts.headers.remove(CONTENT_LENGTH);
            Response::from_parts(parts, Body::empty())
        }
    }
}

fn set(headers: &mut HeaderMap, name: axum::http::HeaderName, value: String) {
    if let Ok(v) = HeaderValue::from_str(&value) {
        headers.insert(name, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    #[test]
    fn a_range_reads_as_the_browser_means_it() {
        assert_eq!(span(None, 100), Span::Whole);
        assert_eq!(span(Some("bytes=0-"), 100), Span::Part(0, 99), "Chrome's first ask");
        assert_eq!(span(Some("bytes=10-19"), 100), Span::Part(10, 19));
        assert_eq!(span(Some("bytes=90-500"), 100), Span::Part(90, 99), "clipped to the end");
        assert_eq!(span(Some("bytes=-8"), 100), Span::Part(92, 99), "the last page");
        assert_eq!(span(Some("bytes=-500"), 100), Span::Part(0, 99));
        assert_eq!(span(Some("bytes=100-"), 100), Span::Unsatisfiable);
        assert_eq!(span(Some("bytes=0-1,5-6"), 100), Span::Whole, "one range only");
        assert_eq!(span(Some("bytes=9-3"), 100), Span::Whole, "backwards is ignored");
        assert_eq!(span(Some("items=0-3"), 100), Span::Whole);
        assert_eq!(span(Some("bytes=0-"), 0), Span::Unsatisfiable);
    }

    async fn answer(range: Option<&str>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let whole = (StatusCode::OK, b"0123456789".to_vec()).into_response();
        let r = apply(range, whole).await;
        let (parts, body) = r.into_parts();
        (parts.status, parts.headers, axum::body::to_bytes(body, 1024).await.unwrap().to_vec())
    }

    #[tokio::test]
    async fn a_body_answers_in_parts() {
        let (status, headers, body) = answer(None).await;
        assert_eq!((status, body.as_slice()), (StatusCode::OK, &b"0123456789"[..]));
        assert_eq!(headers[ACCEPT_RANGES], "bytes", "and says it can");

        let (status, headers, body) = answer(Some("bytes=2-4")).await;
        assert_eq!((status, body.as_slice()), (StatusCode::PARTIAL_CONTENT, &b"234"[..]));
        assert_eq!(headers[CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(headers[CONTENT_LENGTH], "3");

        let (status, headers, body) = answer(Some("bytes=20-")).await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(headers[CONTENT_RANGE], "bytes */10");
        assert!(body.is_empty());

        let not_modified = StatusCode::NOT_MODIFIED.into_response();
        assert_eq!(apply(Some("bytes=0-"), not_modified).await.status(), StatusCode::NOT_MODIFIED);
    }
}
