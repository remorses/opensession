-- Phase 6 adds the exact five-table organization speaker CRM. Pipeline stages
-- are fixed in application code; segments store only explicit supported criteria.
CREATE TABLE `org_contact` (
  `id` text PRIMARY KEY,
  `org_id` text NOT NULL,
  `email` text NOT NULL,
  `first_name` text NOT NULL,
  `last_name` text NOT NULL,
  `job_title` text,
  `company_name` text,
  `bio` text,
  `stage` text,
  `score` integer,
  `rationale` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `fk_org_contact_org_id_org_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`org_id`) ON DELETE CASCADE,
  CONSTRAINT `org_contact_stage_check` CHECK (`stage` IS NULL OR `stage` IN ('RESEARCHING', 'IDENTIFIED', 'CONTACTED', 'INTERESTED', 'CONFIRMED', 'DECLINED')),
  CONSTRAINT `org_contact_score_check` CHECK (`score` IS NULL OR (`score` >= 0 AND `score` <= 100))
);
CREATE UNIQUE INDEX `org_contact_org_email_unique` ON `org_contact` (`org_id`, `email`);
CREATE UNIQUE INDEX `org_contact_id_org_unique` ON `org_contact` (`id`, `org_id`);
CREATE INDEX `org_contact_org_name_idx` ON `org_contact` (`org_id`, `last_name`, `first_name`);
CREATE INDEX `org_contact_org_stage_idx` ON `org_contact` (`org_id`, `stage`);

CREATE TABLE `contact_tag` (
  `id` text PRIMARY KEY,
  `org_id` text NOT NULL,
  `name` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_contact_tag_org_id_org_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`org_id`) ON DELETE CASCADE,
  CONSTRAINT `contact_tag_name_check` CHECK (length(trim(`name`)) > 0)
);
CREATE UNIQUE INDEX `contact_tag_org_name_unique` ON `contact_tag` (`org_id`, `name`);
CREATE UNIQUE INDEX `contact_tag_id_org_unique` ON `contact_tag` (`id`, `org_id`);
CREATE INDEX `contact_tag_org_idx` ON `contact_tag` (`org_id`);

CREATE TABLE `contact_tag_link` (
  `id` text PRIMARY KEY,
  `org_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `tag_id` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `contact_tag_link_contact_org_fk` FOREIGN KEY (`contact_id`, `org_id`) REFERENCES `org_contact`(`id`, `org_id`) ON DELETE CASCADE,
  CONSTRAINT `contact_tag_link_tag_org_fk` FOREIGN KEY (`tag_id`, `org_id`) REFERENCES `contact_tag`(`id`, `org_id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `contact_tag_link_contact_tag_unique` ON `contact_tag_link` (`contact_id`, `tag_id`);
CREATE INDEX `contact_tag_link_org_idx` ON `contact_tag_link` (`org_id`);
CREATE INDEX `contact_tag_link_tag_idx` ON `contact_tag_link` (`tag_id`);

CREATE TABLE `contact_segment` (
  `id` text PRIMARY KEY,
  `org_id` text NOT NULL,
  `name` text NOT NULL,
  `company_name` text,
  `job_title` text,
  `tag_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `fk_contact_segment_org_id_org_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`org_id`) ON DELETE CASCADE,
  CONSTRAINT `contact_segment_tag_org_fk` FOREIGN KEY (`tag_id`, `org_id`) REFERENCES `contact_tag`(`id`, `org_id`) ON DELETE CASCADE,
  CONSTRAINT `contact_segment_criteria_check` CHECK (`company_name` IS NOT NULL OR `job_title` IS NOT NULL OR `tag_id` IS NOT NULL)
);
CREATE UNIQUE INDEX `contact_segment_org_name_unique` ON `contact_segment` (`org_id`, `name`);
CREATE INDEX `contact_segment_org_idx` ON `contact_segment` (`org_id`);

CREATE TABLE `contact_activity` (
  `id` text PRIMARY KEY,
  `org_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `kind` text NOT NULL,
  `body` text,
  `from_stage` text,
  `to_stage` text,
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_contact_activity_actor_user_id_user_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `contact_activity_contact_org_fk` FOREIGN KEY (`contact_id`, `org_id`) REFERENCES `org_contact`(`id`, `org_id`) ON DELETE CASCADE,
  CONSTRAINT `contact_activity_kind_check` CHECK (`kind` IN ('NOTE', 'STAGE_TRANSITION', 'OUTREACH', 'EVENT_ADDED', 'MERGE')),
  CONSTRAINT `contact_activity_transition_check` CHECK ((`kind` = 'STAGE_TRANSITION' AND `to_stage` IS NOT NULL) OR (`kind` <> 'STAGE_TRANSITION' AND `from_stage` IS NULL AND `to_stage` IS NULL)),
  CONSTRAINT `contact_activity_body_check` CHECK (`kind` = 'STAGE_TRANSITION' OR (`body` IS NOT NULL AND length(trim(`body`)) > 0))
);
CREATE INDEX `contact_activity_contact_created_idx` ON `contact_activity` (`contact_id`, `created_at`);
CREATE INDEX `contact_activity_org_kind_idx` ON `contact_activity` (`org_id`, `kind`);

ALTER TABLE `speaker` ADD COLUMN `contact_id` text REFERENCES `org_contact`(`id`) ON DELETE SET NULL;
CREATE INDEX `speaker_contact_id_idx` ON `speaker` (`contact_id`);
ALTER TABLE `email_message` ADD COLUMN `contact_id` text REFERENCES `org_contact`(`id`) ON DELETE SET NULL;
CREATE INDEX `email_message_contact_idx` ON `email_message` (`contact_id`);

-- Existing event speakers become canonical contacts by normalized email within
-- their owning organization. One grouped row wins profile values deterministically.
INSERT INTO `org_contact` (
  `id`, `org_id`, `email`, `first_name`, `last_name`, `job_title`,
  `company_name`, `bio`, `created_at`, `updated_at`
)
SELECT
  'contact-' || lower(hex(randomblob(16))), event.`org_id`, lower(trim(speaker.`email`)),
  min(speaker.`first_name`), min(speaker.`last_name`), min(speaker.`job_title`),
  min(speaker.`company_name`), min(speaker.`bio`), min(speaker.`created_at`), max(speaker.`updated_at`)
FROM `speaker`
JOIN `event` ON event.`id` = speaker.`event_id`
GROUP BY event.`org_id`, lower(trim(speaker.`email`));

UPDATE `speaker`
SET `contact_id` = (
  SELECT contact.`id`
  FROM `org_contact` contact
  JOIN `event` ON event.`org_id` = contact.`org_id`
  WHERE event.`id` = speaker.`event_id`
    AND contact.`email` = lower(trim(speaker.`email`))
  LIMIT 1
);

UPDATE `email_message`
SET `contact_id` = (
  SELECT speaker.`contact_id` FROM `speaker` WHERE speaker.`id` = email_message.`speaker_id`
)
WHERE `speaker_id` IS NOT NULL;

-- The existing speaker and email tables do not repeat org_id. Enforce the
-- contact tenant through their event owner so no write path can create a
-- cross-organization link, including future actions and direct SQL imports.
CREATE TRIGGER `speaker_contact_org_insert`
BEFORE INSERT ON `speaker`
WHEN NEW.`contact_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `org_contact` contact
    JOIN `event` ON event.`id` = NEW.`event_id`
    WHERE contact.`id` = NEW.`contact_id` AND contact.`org_id` = event.`org_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'speaker contact organization mismatch');
END;

CREATE TRIGGER `speaker_contact_org_update`
BEFORE UPDATE OF `contact_id`, `event_id` ON `speaker`
WHEN NEW.`contact_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `org_contact` contact
    JOIN `event` ON event.`id` = NEW.`event_id`
    WHERE contact.`id` = NEW.`contact_id` AND contact.`org_id` = event.`org_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'speaker contact organization mismatch');
END;

CREATE TRIGGER `email_contact_org_insert`
BEFORE INSERT ON `email_message`
WHEN NEW.`contact_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `org_contact` contact
    JOIN `event` ON event.`id` = NEW.`event_id`
    WHERE contact.`id` = NEW.`contact_id` AND contact.`org_id` = event.`org_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'email contact organization mismatch');
END;

CREATE TRIGGER `email_contact_org_update`
BEFORE UPDATE OF `contact_id`, `event_id` ON `email_message`
WHEN NEW.`contact_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `org_contact` contact
    JOIN `event` ON event.`id` = NEW.`event_id`
    WHERE contact.`id` = NEW.`contact_id` AND contact.`org_id` = event.`org_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'email contact organization mismatch');
END;
