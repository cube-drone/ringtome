// Many files at once (Curtis, 2026-10-11: "can I drop in an entire directory of mp3s?"): what a
// folder dropped on the upload window gives up, in what order, and how many go up at a time. The
// walk itself is the browser's (doc/dropfiles.js); these are its rules.

/// The media a folder's walk keeps, by type or, where the platform names none, by extension. A
/// folder of music carries its playlists, cue sheets, logs and `.DS_Store` beside the tracks, and
/// none of those is anything the node can store - so they're passed over quietly here, where a file
/// dropped on its own is still shown failing, as one chosen by hand should be.
const MEDIA_TYPE = /^(image|audio|video)\//;
const MEDIA_EXTENSION =
    /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|aif|aiff|png|jpe?g|gif|webp|avif|bmp|mp4|m4v|mov|webm|mkv)$/i;

export function folderKeeps(name, type) {
    if (!name || name.startsWith('.')) return false;
    return type ? MEDIA_TYPE.test(type) : MEDIA_EXTENSION.test(name);
}

/// A folder's files in the order its listing reads: by path, numbers as numbers - so "2 - Buck"
/// comes before "10 - Doe", as a track list does.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const byPath = (a, b) => collator.compare(a, b);

/// Run `work(item, index)` over `items`, at most `limit` at once, each starting as one finishes:
/// thirty tracks go up three at a time rather than thirty abreast, each bar moving when it moves.
/// `onStart(index)` says when each one's turn comes. Resolves when all are done; a failure is the
/// work's own to report, and never stops the rest.
export async function pooled(items, limit, work, onStart = () => {}) {
    let next = 0;
    const lane = async () => {
        while (next < items.length) {
            const i = next++;
            onStart(i);
            try {
                await work(items[i], i);
            } catch {
                /* the work reports its own failure */
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
