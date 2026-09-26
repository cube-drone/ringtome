// The Backups page's arithmetic (apps/device.js): when an archive was made, read off its name, and
// how big it is in words a person reads. The node names every archive `backup_<UTC stamp>.tar.gz`
// (node/src/backup.rs), so the name IS the date and nothing else needs asking.

/// The moment an archive was made, as epoch milliseconds, from `backup_YYYYMMDDTHHMMSSZ.tar.gz`;
/// null for any other name.
export function backupTime(name) {
    const m = /^backup_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.gz$/.exec(name || '');
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, s);
}

/// A size, rounded the way a person says it: bytes under a kilobyte, then KB, MB, GB with one
/// decimal below ten and none above. Powers of 1024, labelled the everyday way.
export function sizeLabel(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
