// A pick from the image picker (doc/imagepick.js) as the reference a note or a chat message embeds
// (Curtis, 2026-09-27: the picker in hrseWriter, the feed composer and chat). A picture from your
// media is referenced as it is - spelled from its real format and animation, as an upload's is
// once processed (pure/mediakind.js crushedReference). A drawing is first copied in flat as a
// still picture of its own (doc/drawing.js drawingAsPicture, filed in "files") and that is
// referenced: a copy, never a live link, as the drawing's own "add an image" does it.
import { crushedReference } from '../pure/mediakind.js';
import { drawingAsPicture } from './drawing.js';

/// The embed for `pick` in a body of `bodyFormat` ('marquee', or 'plaintext' for a bare URL).
export async function pickedReference(root, pick, bodyFormat = 'marquee') {
    if (pick.format === 'drawing') {
        const copy = await drawingAsPicture(root, pick.doc);
        // The copy is a still PNG the node makes an AVIF, like any still picture.
        return crushedReference({
            root,
            docFormat: 'avif',
            docId: copy.doc,
            title: copy.title,
            animation: false,
            bodyFormat,
        });
    }
    return crushedReference({
        root,
        docFormat: pick.format,
        docId: pick.doc,
        title: pick.title,
        animation: !!pick.animation,
        bodyFormat,
    });
}
