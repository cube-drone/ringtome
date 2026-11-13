// The age screen's rule (plans/STORES.md, section 1; the server's is src/store.rs, `admit_age`).
//
// A store build asks the year someone was born, and a year alone leaves a year of doubt: before
// their birthday they are one less than the difference. Anyone who might be under the age is
// turned away (Curtis, 2026-11-12).

export const MINIMUM_AGE = 13;

/// 'ok', 'young' (might be under the age), or 'none' (not a year anybody alive was born in).
export const ageAnswer = (birthYear, thisYear) => {
    const year = Number(birthYear);
    if (!Number.isInteger(year) || year < 1900 || year > thisYear) return 'none';
    return thisYear - year - 1 >= MINIMUM_AGE ? 'ok' : 'young';
};
