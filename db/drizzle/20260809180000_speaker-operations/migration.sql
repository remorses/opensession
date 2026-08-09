-- Phase 3 speaker operations reuse the roster, task assignment, and email outbox tables.
ALTER TABLE `speaker` ADD COLUMN `status` text DEFAULT 'PENDING' NOT NULL
  CHECK (`status` IN ('PENDING', 'INVITED', 'CONFIRMED', 'DECLINED'));

ALTER TABLE `task_definition` ADD COLUMN `assignment_policy` text DEFAULT 'ALL_ACCEPTED' NOT NULL
  CHECK (`assignment_policy` IN ('SELECTED', 'ALL_ACCEPTED'));

-- SQLite cannot alter the existing EmailKind CHECK. Rebuild only the outbox
-- table, preserving every rendered snapshot and delivery attempt.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE `__new_email_message` (
  `id` text PRIMARY KEY,
  `event_id` text NOT NULL,
  `kind` text NOT NULL,
  `dedupe_key` text NOT NULL UNIQUE,
  `batch_id` text,
  `to_email` text NOT NULL,
  `speaker_id` text,
  `session_id` text,
  `subject` text NOT NULL,
  `body_html` text NOT NULL,
  `body_text` text,
  `ics_method` text,
  `ics_sequence` integer,
  `ics_body` text,
  `status` text DEFAULT 'QUEUED' NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `last_attempt_at` integer,
  `error_message` text,
  `sent_at` integer,
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_email_message_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_email_message_speaker_id_speaker_id_fk` FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_email_message_session_id_event_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `event_session`(`id`) ON DELETE SET NULL,
  CONSTRAINT `email_message_kind_check` CHECK (`kind` IN ('SUBMISSION_CONFIRMATION', 'DECISION_ACCEPTED', 'DECISION_DECLINED', 'TASK_ASSIGNED', 'TASK_REMINDER', 'DRAFT_REMINDER', 'SCHEDULE_INVITE', 'SCHEDULE_UPDATE', 'SCHEDULE_CANCEL', 'REVIEWER_INVITE', 'REVIEW_REMINDER', 'SPEAKER_INVITE', 'CUSTOM')),
  CONSTRAINT `email_message_status_check` CHECK (`status` IN ('QUEUED', 'SENT', 'FAILED')),
  CONSTRAINT `email_message_ics_method_check` CHECK (`ics_method` IS NULL OR `ics_method` IN ('REQUEST', 'CANCEL'))
);
INSERT INTO `__new_email_message` (`id`, `event_id`, `kind`, `dedupe_key`, `to_email`, `speaker_id`, `session_id`, `subject`, `body_html`, `body_text`, `ics_method`, `ics_sequence`, `ics_body`, `status`, `attempt_count`, `last_attempt_at`, `error_message`, `sent_at`, `created_at`)
SELECT `id`, `event_id`, `kind`, `dedupe_key`, `to_email`, `speaker_id`, `session_id`, `subject`, `body_html`, `body_text`, `ics_method`, `ics_sequence`, `ics_body`, `status`, `attempt_count`, `last_attempt_at`, `error_message`, `sent_at`, `created_at` FROM `email_message`;
DROP TABLE `email_message`;
ALTER TABLE `__new_email_message` RENAME TO `email_message`;
CREATE INDEX `email_message_event_status_idx` ON `email_message` (`event_id`, `status`);
CREATE INDEX `email_message_speaker_idx` ON `email_message` (`speaker_id`);
CREATE INDEX `email_message_session_idx` ON `email_message` (`session_id`);
CREATE INDEX `email_message_batch_idx` ON `email_message` (`batch_id`);
PRAGMA defer_foreign_keys = OFF;
