-- Phase 4 reuses task assignments and form values for deliverable versions.
CREATE UNIQUE INDEX `task_assignment_id_event_unique` ON `task_assignment` (`id`, `event_id`);

ALTER TABLE `file` ADD COLUMN `task_assignment_id` text REFERENCES `task_assignment`(`id`) ON DELETE SET NULL;
ALTER TABLE `file` ADD COLUMN `field_name` text;
CREATE INDEX `file_task_slot_created_idx` ON `file` (`task_assignment_id`, `field_name`, `created_at`);

-- SQLite cannot add a composite FK to an existing table without rebuilding it.
-- These triggers enforce the same event boundary without touching existing file links.
CREATE TRIGGER `file_task_slot_insert_guard`
BEFORE INSERT ON `file`
WHEN NEW.`task_assignment_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `task_assignment`
    WHERE `id` = NEW.`task_assignment_id` AND `event_id` = NEW.`event_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'task assignment event mismatch');
END;

CREATE TRIGGER `file_task_slot_update_guard`
BEFORE UPDATE OF `task_assignment_id`, `event_id` ON `file`
WHEN NEW.`task_assignment_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `task_assignment`
    WHERE `id` = NEW.`task_assignment_id` AND `event_id` = NEW.`event_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'task assignment event mismatch');
END;

CREATE TABLE `task_comment` (
  `id` text PRIMARY KEY,
  `task_assignment_id` text NOT NULL,
  `field_name` text NOT NULL,
  `author_user_id` text NOT NULL,
  `body` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `task_comment_assignment_fk` FOREIGN KEY (`task_assignment_id`) REFERENCES `task_assignment`(`id`) ON DELETE CASCADE,
  CONSTRAINT `task_comment_author_fk` FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `task_comment_field_check` CHECK (length(trim(`field_name`)) > 0),
  CONSTRAINT `task_comment_body_check` CHECK (length(trim(`body`)) > 0)
);
CREATE INDEX `task_comment_assignment_field_created_idx` ON `task_comment` (`task_assignment_id`, `field_name`, `created_at`);
CREATE INDEX `task_comment_author_idx` ON `task_comment` (`author_user_id`);

CREATE TABLE `session_revision` (
  `id` text PRIMARY KEY,
  `event_id` text NOT NULL,
  `session_id` text NOT NULL,
  `title` text,
  `description` text,
  `track_id` text,
  `format_id` text,
  `cover_image_file_id` text,
  `editor_user_id` text NOT NULL,
  `restored_from_revision_id` text,
  `created_at` integer NOT NULL,
  CONSTRAINT `session_revision_session_event_fk` FOREIGN KEY (`session_id`, `event_id`) REFERENCES `event_session`(`id`, `event_id`) ON DELETE CASCADE,
  CONSTRAINT `session_revision_editor_fk` FOREIGN KEY (`editor_user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `session_revision_restored_from_fk` FOREIGN KEY (`restored_from_revision_id`) REFERENCES `session_revision`(`id`)
);
CREATE INDEX `session_revision_session_created_idx` ON `session_revision` (`session_id`, `created_at`);
CREATE INDEX `session_revision_editor_idx` ON `session_revision` (`editor_user_id`);
