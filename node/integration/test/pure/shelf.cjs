const assert = require('node:assert');

let shelfItem;
before(async () => {
    ({ shelfItem } = await import('../../../js/pure/shelf.js'));
});

describe("a person's shelf row as a card item (2026-09-08)", () => {
    const dress = { root: 'r'.repeat(64), authorName: 'Reach Cameo', authorAvatar: 'av', mine: false };
    it("a share keeps its original author and wears the page's persona as its via", () => {
        const share = shelfItem({ kind: 'share', author: 'a'.repeat(64), doc_id: 'd', title: 't', format: 'marquee', published_ms: 5, via: dress.root }, dress);
        assert.equal(share.author, 'a'.repeat(64), 'the card is still that person speaking');
        assert.equal(share.via, dress.root);
        assert.equal(share.kind, 'share');
        assert.equal(share.mine, false);
        assert.equal(share.author_name, undefined, "the page's name is not the sharer's");
    });
    it("a post is the page's persona's, with their name and face", () => {
        const post = shelfItem({ doc_id: 'd', title: 't', format: 'marquee', published_ms: 5, annotations: [] }, dress);
        assert.equal(post.author, dress.root);
        assert.equal(post.author_name, 'Reach Cameo');
        assert.equal(post.kind, undefined);
    });
});
