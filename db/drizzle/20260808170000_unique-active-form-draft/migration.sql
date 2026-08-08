-- Keep concurrent CFP page loads from creating duplicate editable drafts.
CREATE UNIQUE INDEX `form_response_active_draft_unique`
ON `form_response` (`form_id`, `speaker_id`)
WHERE `status` = 'DRAFT';
