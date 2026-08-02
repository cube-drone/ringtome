// Profile field limits. The WIRE cap is proto's ProfileSet::MAX_VALUE_LEN - 4096 bytes of
// UTF-8, any field - but the UI holds names and bios to cozier bounds, in CHARACTERS
// (code points: one emoji is one character to the person counting). The two never conflict
// by construction: the worst UTF-8 character spends 4 bytes, and 4x the largest UI cap
// still sits under the wire cap - a vector pins that inequality so a future cap bump can't
// silently reopen the invisible-400 hole this module exists to close (field-found
// 2026-08-02: an over-cap bio failed with a 400 the user never saw).

export const WIRE_VALUE_MAX_BYTES = 4096;

/// Per-field UI caps, characters. Fields absent here get no UI cap (the wire cap stands).
export const PROFILE_LIMITS = { name: 64, bio: 512 };

/// What a value costs against a UI cap: code points, the human's idea of a character.
export const profileChars = (s) => [...(s || '')].length;

/// Too big for this field - the counter turns red and the save button refuses.
export const overProfileLimit = (field, s) => {
    const cap = PROFILE_LIMITS[field];
    return cap !== undefined && profileChars(s) > cap;
};
