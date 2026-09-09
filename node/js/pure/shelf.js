// A person's shelf row, dressed as the card's item (2026-09-08). One mapper for both roads
// the shelf arrives by - the profile's first page and the narrowed listing - because the
// two had drifted: the narrowed road stamped the page's persona onto every row, shares
// included, and a share's card asked the wrong persona for words somebody else wrote.
// A share keeps its ORIGINAL author (the card is still that person speaking) and wears
// this persona as its via line, exactly as the feed renders a passed-along post.

export function shelfItem(p, { root, authorName, authorAvatar, mine }) {
    if (p.kind === 'share') {
        return {
            kind: 'share',
            author: p.author,
            doc_id: p.doc_id,
            title: p.title,
            format: p.format,
            published_ms: p.published_ms,
            via: p.via,
            mine: false,
        };
    }
    return {
        author: root,
        doc_id: p.doc_id,
        title: p.title,
        format: p.format,
        published_ms: p.published_ms,
        dated_ms: p.dated_ms,
        minted_ms: p.minted_ms,
        replies: p.replies,
        reply_to: p.reply_to,
        thread_root: p.thread_root,
        trusted_only: p.trusted_only,
        settled: p.settled,
        annotations: p.annotations,
        author_name: authorName,
        author_avatar: authorAvatar,
        mine,
    };
}
