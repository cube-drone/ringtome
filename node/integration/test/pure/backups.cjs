/*
    The Backups page reads an archive's date off its name (node/src/backup.rs names every one
    `backup_<UTC stamp>.tar.gz`) and says its size the way a person does.
*/
const assert = require('node:assert');

let backupTime, sizeLabel;
before(async () => {
    ({ backupTime, sizeLabel } = await import('../../../js/pure/backups.js'));
});

describe('backups, as the page shows them', () => {
    it('reads the moment off the name, in UTC', () => {
        assert.equal(backupTime('backup_20260925T183012Z.tar.gz'), Date.UTC(2026, 8, 25, 18, 30, 12));
        assert.equal(new Date(backupTime('backup_20260925T183012Z.tar.gz')).toISOString(), '2026-09-25T18:30:12.000Z');
    });

    it('knows no date for anything that is not an archive name', () => {
        for (const name of ['backup_20260925T183012Z.tar.gz.partial', '.staging-20260925T183012Z', 'backup_2026.tar.gz', '', undefined]) {
            assert.equal(backupTime(name), null, String(name));
        }
    });

    it('says sizes the way a person does', () => {
        assert.equal(sizeLabel(0), '0 B');
        assert.equal(sizeLabel(1023), '1023 B');
        assert.equal(sizeLabel(1024), '1.0 KB');
        assert.equal(sizeLabel(1536), '1.5 KB');
        assert.equal(sizeLabel(20 * 1024 * 1024), '20 MB');
        assert.equal(sizeLabel(3.25 * 1024 ** 3), '3.3 GB');
        assert.equal(sizeLabel(undefined), '');
    });
});
