-- Replace form-backed evaluation rounds with simple vote/rating/comment reviews.
-- Org members review abstracts directly. No scorecard forms, reviewer pools, or assignments.
PRAGMA defer_foreign_keys = ON;

-- Drop scorecard answers owned by evaluation reviews.
DELETE FROM form_field_value
WHERE response_id IN (SELECT id FROM form_response WHERE review_id IS NOT NULL);
DELETE FROM form_response WHERE review_id IS NOT NULL;

-- Drop reviewer invites and form-backed assignments.
DELETE FROM org_invitation WHERE purpose = 'EVALUATION_REVIEWER';
DELETE FROM email_message
WHERE kind IN ('REVIEWER_INVITE', 'REVIEW_REMINDER')
  AND status IN ('QUEUED', 'FAILED');
DROP TABLE IF EXISTS review;
DROP TABLE IF EXISTS evaluation_reviewer;

-- Detach FORM tasks that pointed at evaluation scorecards (become MANUAL).
UPDATE task_definition
SET form_id = NULL, source = 'MANUAL'
WHERE form_id IN (SELECT id FROM form WHERE purpose = 'EVALUATION');

-- Delete evaluation forms after their responses, reviewer rows, invitations,
-- and task references have been detached. Keep the existing form tables as a
-- compatible schema superset. Rebuilding them would make SQLite enforce the
-- old form_response RESTRICT references while the parent table is absent.
DELETE FROM form WHERE purpose = 'EVALUATION';

-- Simple review: one vote/rating/comment per org member per session.
CREATE TABLE `review` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `form_id` text,
  `session_id` text NOT NULL,
  `reviewer_id` text NOT NULL,
  `vote` text NOT NULL,
  `rating` integer,
  `comment` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `fk_review_reviewer_id_user_id_fk` FOREIGN KEY (`reviewer_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `review_session_fk` FOREIGN KEY (`session_id`, `event_id`) REFERENCES `event_session`(`id`, `event_id`) ON DELETE CASCADE,
  CONSTRAINT `review_vote_check` CHECK(vote IN ('YES', 'MAYBE', 'NO')),
  CONSTRAINT `review_rating_check` CHECK(rating IS NULL OR rating BETWEEN 1 AND 5)
);
CREATE UNIQUE INDEX `review_session_reviewer_unique` ON `review` (`session_id`, `reviewer_id`);
CREATE UNIQUE INDEX `review_id_form_event_unique` ON `review` (`id`, `form_id`, `event_id`);
CREATE INDEX `review_reviewer_idx` ON `review` (`reviewer_id`);
CREATE INDEX `review_event_idx` ON `review` (`event_id`);
