-- Phase 2 evaluation workflow: rounds reuse forms, assignments reuse reviews,
-- scorecard answers reuse form responses, and reviewer invites reuse org invites.
PRAGMA defer_foreign_keys = ON;

CREATE UNIQUE INDEX `event_id_org_unique` ON `event` (`id`, `org_id`);

-- Detach the cascading form_version child before rebuilding form. Deferring
-- constraints does not stop ON DELETE CASCADE from deleting version rows when
-- the old parent table is dropped.
CREATE TABLE `__detached_form_version` (
  `id` text PRIMARY KEY,
  `form_id` text NOT NULL,
  `mdx_source` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `detached_form_version_form_fk` FOREIGN KEY (`form_id`) REFERENCES `form`(`id`)
);
INSERT INTO `__detached_form_version` SELECT * FROM `form_version`;
DROP TABLE `form_version`;
ALTER TABLE `__detached_form_version` RENAME TO `form_version`;
CREATE INDEX `form_version_form_created_idx` ON `form_version` (`form_id`, `created_at`);

CREATE TABLE `__new_form` (
  `id` text PRIMARY KEY,
  `event_id` text NOT NULL,
  `purpose` text NOT NULL,
  `target` text DEFAULT 'SUBMISSION' NOT NULL,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `status` text DEFAULT 'DRAFT' NOT NULL,
  `opens_at` integer,
  `closes_at` integer,
  `blind` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `fk_form_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
  CONSTRAINT `form_purpose_check` CHECK(purpose IN ('CFP', 'PORTAL', 'EVALUATION')),
  CONSTRAINT `form_target_check` CHECK(target IN ('SUBMISSION', 'SPEAKER')),
  CONSTRAINT `form_status_check` CHECK(status IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'))
);
INSERT INTO `__new_form` (`id`, `event_id`, `purpose`, `target`, `name`, `slug`, `status`, `closes_at`, `created_at`, `updated_at`)
SELECT `id`, `event_id`, `purpose`, `target`, `name`, `slug`, `status`, `closes_at`, `created_at`, `updated_at` FROM `form`;
DROP TABLE `form`;
ALTER TABLE `__new_form` RENAME TO `form`;
CREATE INDEX `form_event_id_idx` ON `form` (`event_id`);
CREATE UNIQUE INDEX `form_event_slug_unique` ON `form` (`event_id`, `slug`);
CREATE UNIQUE INDEX `form_id_event_unique` ON `form` (`id`, `event_id`);

-- Restore the intended cascading relation after the parent rebuild.
CREATE TABLE `__new_form_version` (
  `id` text PRIMARY KEY,
  `form_id` text NOT NULL,
  `mdx_source` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_form_version_form_id_form_id_fk` FOREIGN KEY (`form_id`) REFERENCES `form`(`id`) ON DELETE CASCADE
);
INSERT INTO `__new_form_version` SELECT * FROM `form_version`;
DROP TABLE `form_version`;
ALTER TABLE `__new_form_version` RENAME TO `form_version`;
CREATE INDEX `form_version_form_created_idx` ON `form_version` (`form_id`, `created_at`);
CREATE UNIQUE INDEX `form_version_id_form_unique` ON `form_version` (`id`, `form_id`);

CREATE TABLE `__new_org_invitation` (
  `invitation_id` text PRIMARY KEY,
  `org_id` text NOT NULL,
  `purpose` text DEFAULT 'ORG_MEMBER' NOT NULL,
  `role` text DEFAULT 'member' NOT NULL,
  `invited_email` text,
  `event_id` text,
  `form_id` text,
  `created_by` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_org_invitation_org_id_org_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`org_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_org_invitation_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `org_invitation_event_org_fk` FOREIGN KEY (`event_id`, `org_id`) REFERENCES `event`(`id`, `org_id`) ON DELETE CASCADE,
  CONSTRAINT `org_invitation_form_event_fk` FOREIGN KEY (`form_id`, `event_id`) REFERENCES `form`(`id`, `event_id`) ON DELETE CASCADE,
  CONSTRAINT `org_invitation_purpose_check` CHECK(purpose IN ('ORG_MEMBER', 'EVALUATION_REVIEWER')),
  CONSTRAINT `org_invitation_owner_check` CHECK(
    (purpose = 'ORG_MEMBER' AND invited_email IS NULL AND event_id IS NULL AND form_id IS NULL)
    OR
    (purpose = 'EVALUATION_REVIEWER' AND invited_email IS NOT NULL AND event_id IS NOT NULL AND form_id IS NOT NULL)
  )
);
INSERT INTO `__new_org_invitation` (`invitation_id`, `org_id`, `role`, `created_by`, `expires_at`, `created_at`)
SELECT `invitation_id`, `org_id`, `role`, `created_by`, `expires_at`, `created_at` FROM `org_invitation`;
DROP TABLE `org_invitation`;
ALTER TABLE `__new_org_invitation` RENAME TO `org_invitation`;
CREATE INDEX `org_invitation_org_id_idx` ON `org_invitation` (`org_id`);
CREATE INDEX `org_invitation_form_idx` ON `org_invitation` (`form_id`);

CREATE TABLE `evaluation_reviewer` (
  `id` text PRIMARY KEY,
  `event_id` text NOT NULL,
  `form_id` text NOT NULL,
  `user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_evaluation_reviewer_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `evaluation_reviewer_form_event_fk` FOREIGN KEY (`form_id`, `event_id`) REFERENCES `form`(`id`, `event_id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `evaluation_reviewer_form_user_unique` ON `evaluation_reviewer` (`form_id`, `user_id`);
CREATE UNIQUE INDEX `evaluation_reviewer_event_form_user_unique` ON `evaluation_reviewer` (`event_id`, `form_id`, `user_id`);
CREATE INDEX `evaluation_reviewer_user_idx` ON `evaluation_reviewer` (`user_id`);
CREATE INDEX `evaluation_reviewer_event_idx` ON `evaluation_reviewer` (`event_id`);

-- Fixed quick-review rows cannot be mapped to a scorecard round. Remove them
-- rather than fabricate round membership or silently alter their meaning.
DROP TABLE `review`;
CREATE TABLE `review` (
  `id` text PRIMARY KEY,
  `event_id` text NOT NULL,
  `form_id` text NOT NULL,
  `session_id` text NOT NULL,
  `reviewer_id` text NOT NULL,
  `recused_at` integer,
  `recusal_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `fk_review_reviewer_id_user_id_fk` FOREIGN KEY (`reviewer_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `review_session_fk` FOREIGN KEY (`session_id`, `event_id`) REFERENCES `event_session`(`id`, `event_id`) ON DELETE CASCADE,
  CONSTRAINT `review_form_event_fk` FOREIGN KEY (`form_id`, `event_id`) REFERENCES `form`(`id`, `event_id`) ON DELETE CASCADE,
  CONSTRAINT `review_pool_fk` FOREIGN KEY (`event_id`, `form_id`, `reviewer_id`) REFERENCES `evaluation_reviewer`(`event_id`, `form_id`, `user_id`) ON DELETE CASCADE,
  CONSTRAINT `review_recusal_check` CHECK((recused_at IS NULL AND recusal_reason IS NULL) OR (recused_at IS NOT NULL AND recusal_reason IS NOT NULL AND length(trim(recusal_reason)) > 0))
);
CREATE UNIQUE INDEX `review_form_session_reviewer_unique` ON `review` (`form_id`, `session_id`, `reviewer_id`);
CREATE UNIQUE INDEX `review_id_form_event_unique` ON `review` (`id`, `form_id`, `event_id`);
CREATE INDEX `review_reviewer_idx` ON `review` (`reviewer_id`);
CREATE INDEX `review_event_form_idx` ON `review` (`event_id`, `form_id`);
CREATE INDEX `review_session_idx` ON `review` (`session_id`);

CREATE TABLE `__new_form_response` (
  `id` text PRIMARY KEY,
  `event_id` text NOT NULL,
  `form_id` text NOT NULL,
  `form_version_id` text NOT NULL,
  `speaker_id` text,
  `review_id` text UNIQUE,
  `session_id` text,
  `task_assignment_id` text UNIQUE,
  `status` text DEFAULT 'DRAFT' NOT NULL,
  `submitted_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `form_response_form_event_fk` FOREIGN KEY (`form_id`, `event_id`) REFERENCES `form`(`id`, `event_id`) ON DELETE RESTRICT,
  CONSTRAINT `form_response_version_form_fk` FOREIGN KEY (`form_version_id`, `form_id`) REFERENCES `form_version`(`id`, `form_id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_form_response_speaker_id_speaker_id_fk` FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `form_response_review_form_event_fk` FOREIGN KEY (`review_id`, `form_id`, `event_id`) REFERENCES `review`(`id`, `form_id`, `event_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_form_response_session_id_event_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `event_session`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_form_response_task_assignment_id_task_assignment_id_fk` FOREIGN KEY (`task_assignment_id`) REFERENCES `task_assignment`(`id`) ON DELETE SET NULL,
  CONSTRAINT `form_response_owner_check` CHECK((speaker_id IS NOT NULL AND review_id IS NULL) OR (speaker_id IS NULL AND review_id IS NOT NULL)),
  CONSTRAINT `form_response_status_check` CHECK(status IN ('DRAFT', 'SUBMITTED'))
);
INSERT INTO `__new_form_response` (`id`, `event_id`, `form_id`, `form_version_id`, `speaker_id`, `session_id`, `task_assignment_id`, `status`, `submitted_at`, `created_at`, `updated_at`)
SELECT response.`id`, form.`event_id`, response.`form_id`, response.`form_version_id`, response.`speaker_id`, response.`session_id`, response.`task_assignment_id`, response.`status`, response.`submitted_at`, response.`created_at`, response.`updated_at`
FROM `form_response` response JOIN `form` form ON form.`id` = response.`form_id`;
DROP TABLE `form_response`;
ALTER TABLE `__new_form_response` RENAME TO `form_response`;
CREATE INDEX `form_response_form_status_idx` ON `form_response` (`form_id`, `status`);
CREATE INDEX `form_response_version_idx` ON `form_response` (`form_version_id`);
CREATE INDEX `form_response_speaker_idx` ON `form_response` (`speaker_id`);
CREATE INDEX `form_response_event_idx` ON `form_response` (`event_id`);
CREATE INDEX `form_response_session_idx` ON `form_response` (`session_id`);
CREATE UNIQUE INDEX `form_response_active_draft_unique` ON `form_response` (`form_id`, `speaker_id`) WHERE `status` = 'DRAFT' AND `speaker_id` IS NOT NULL;

CREATE TABLE `__new_email_message` (
  `id` text PRIMARY KEY,
  `event_id` text NOT NULL,
  `kind` text NOT NULL,
  `dedupe_key` text NOT NULL UNIQUE,
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
  CONSTRAINT `email_message_kind_check` CHECK(kind IN ('SUBMISSION_CONFIRMATION', 'DECISION_ACCEPTED', 'DECISION_DECLINED', 'TASK_ASSIGNED', 'TASK_REMINDER', 'DRAFT_REMINDER', 'SCHEDULE_INVITE', 'SCHEDULE_UPDATE', 'SCHEDULE_CANCEL', 'REVIEWER_INVITE', 'REVIEW_REMINDER')),
  CONSTRAINT `email_message_status_check` CHECK(status IN ('QUEUED', 'SENT', 'FAILED')),
  CONSTRAINT `email_message_ics_method_check` CHECK(ics_method IS NULL OR ics_method IN ('REQUEST', 'CANCEL'))
);
INSERT INTO `__new_email_message` (
  `id`, `event_id`, `kind`, `dedupe_key`, `to_email`, `speaker_id`, `session_id`,
  `subject`, `body_html`, `body_text`, `ics_method`, `ics_sequence`, `ics_body`,
  `status`, `attempt_count`, `last_attempt_at`, `error_message`, `sent_at`, `created_at`
)
SELECT
  `id`, `event_id`, `kind`, `dedupe_key`, `to_email`, `speaker_id`, `session_id`,
  `subject`, `body_html`, `body_text`, `ics_method`, `ics_sequence`, `ics_body`,
  `status`, `attempt_count`, `last_attempt_at`, `error_message`, `sent_at`, `created_at`
FROM `email_message`;
DROP TABLE `email_message`;
ALTER TABLE `__new_email_message` RENAME TO `email_message`;
CREATE INDEX `email_message_event_status_idx` ON `email_message` (`event_id`, `status`);
CREATE INDEX `email_message_speaker_idx` ON `email_message` (`speaker_id`);
CREATE INDEX `email_message_session_idx` ON `email_message` (`session_id`);

PRAGMA defer_foreign_keys = OFF;
