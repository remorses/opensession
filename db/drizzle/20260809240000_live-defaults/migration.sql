-- Events and CFP/portal forms should start live so public share links work
-- without a second settings pass. Evaluation rounds stay draft until opened.
-- SQLite keeps old column defaults on existing tables; app inserts set status
-- explicitly. This migration also repairs rows still stuck in draft.

UPDATE `event`
SET `status` = 'ACTIVE',
    `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE `status` = 'DRAFT';

UPDATE `form`
SET `status` = 'OPEN',
    `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE `status` = 'DRAFT'
  AND `purpose` IN ('CFP', 'PORTAL');
