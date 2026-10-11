// The files a drop or a folder pick hands over, folders opened (Curtis, 2026-10-11: "can I drop in
// an entire directory of mp3s?"). A dropped folder arrives as one empty pseudo-file; its contents
// are read through the drop's entries (`webkitGetAsEntry`, in every browser we run in), which have to
// be TAKEN while the drop event is still running - the list empties when it returns - and can be
// read afterwards. What a folder keeps, and in what order, is pure/dropfiles.js.
import { folderKeeps, byPath } from '../pure/dropfiles.js';

/// Every entry under a directory entry, read in the batches the browser hands them out in.
const readAll = (dir) =>
    new Promise((resolve, reject) => {
        const reader = dir.createReader();
        const out = [];
        const more = () =>
            reader.readEntries((batch) => {
                if (!batch.length) return resolve(out);
                out.push(...batch);
                more();
            }, reject);
        more();
    });

const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

/// A folder's media files, every level down, with their paths for the order.
async function walk(dir, into) {
    for (const entry of await readAll(dir)) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory) {
            await walk(entry, into);
        } else {
            const file = await fileOf(entry);
            if (folderKeeps(file.name, file.type)) into.push({ path: entry.fullPath, file });
        }
    }
}

/// The files a drop carries: loose files as they are (one that can't be stored is still shown
/// failing - it was chosen), and each folder's media in its listing's order. Call it inside the
/// drop handler; it reads the folders after.
export function droppedFiles(dataTransfer) {
    const items = Array.from((dataTransfer && dataTransfer.items) || []);
    const loose = Array.from((dataTransfer && dataTransfer.files) || []);
    const entries = items.map((item) =>
        item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null,
    );
    if (!entries.some((e) => e && e.isDirectory)) return Promise.resolve(loose);
    const files = items.map((item, i) =>
        entries[i] && entries[i].isFile ? item.getAsFile() : null,
    );
    return (async () => {
        const out = [];
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry && entry.isDirectory) {
                const found = [];
                await walk(entry, found);
                found.sort((a, b) => byPath(a.path, b.path));
                out.push(...found.map((f) => f.file));
            } else if (files[i]) {
                out.push(files[i]);
            }
        }
        return out;
    })();
}

/// The files a folder pick (`<input webkitdirectory>`) chose: its media, in its listing's order.
export function pickedFolder(fileList) {
    return Array.from(fileList || [])
        .filter(
            (f) =>
                folderKeeps(f.name, f.type) &&
                !(f.webkitRelativePath || '').split('/').some((part) => part.startsWith('.')),
        )
        .sort((a, b) => byPath(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
}
