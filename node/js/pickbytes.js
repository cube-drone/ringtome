// A picture chosen from your own drawings and media, as bytes for an upload door: the profile's
// avatar and banner (persona.js), and a group's (groups.js).
import { api } from './net.js';
import { flattenToBlob } from './doc/drawing.js';
import { readBody } from './pure/drawing.js';
import { t } from './i18n.js';

/// The longest side a profile picture is sent at: the node keeps an avatar small, and a phone
/// photo at full size would only be a slower upload to the same result.
const AVATAR_MAX_SIDE = 1024;

/// A picture chosen for the profile (Curtis, 2026-09-27: make your own rather than upload one) as
/// image bytes for the avatar door, made here in the browser: a drawing flattened - its pictures
/// and fonts waited for, as a publication does - or a picture from your media drawn onto a canvas,
/// no larger than AVATAR_MAX_SIDE. Either way a PNG, which the node's image ingest takes like any
/// upload; the avatar is public, so the node makes it a born-public picture of its own, and the
/// original stays as private as it was. A group's picture and banner are chosen the same way
/// (groups.js).
export async function avatarBytes(root, pick) {
    if (pick.format === 'drawing') {
        const detail = await api(`/api/identity/${root}/docs/${pick.doc}`);
        if (detail.body == null)
            throw new Error(
                t(
                    'persona.drawing-not-here-yet',
                    'that drawing has not reached this computer yet - try again in a moment',
                ),
            );
        return flattenToBlob(root, readBody(detail.body));
    }
    const img = new Image();
    img.src = `/api/identity/${root}/docs/${pick.doc}/body`;
    await img.decode();
    const scale = Math.min(1, AVATAR_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
        canvas.toBlob(
            (b) =>
                b
                    ? resolve(b)
                    : reject(
                          new Error(
                              t(
                                  'persona.could-not-read-that-picture',
                                  'could not read that picture',
                              ),
                          ),
                      ),
            'image/png',
        ),
    );
}
