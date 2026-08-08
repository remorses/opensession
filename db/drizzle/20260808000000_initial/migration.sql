CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `email_message` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL UNIQUE,
	`to_email` text NOT NULL,
	`speaker_id` text,
	`session_id` text,
	`subject` text NOT NULL,
	`body_html` text NOT NULL,
	`ics_method` text,
	`ics_sequence` integer,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`error_message` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_email_message_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_email_message_speaker_id_speaker_id_fk` FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_email_message_session_id_event_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `event_session`(`id`) ON DELETE SET NULL,
	CONSTRAINT "email_message_kind_check" CHECK(kind IN ('SUBMISSION_CONFIRMATION', 'DECISION_ACCEPTED', 'DECISION_DECLINED', 'TASK_ASSIGNED', 'TASK_REMINDER', 'DRAFT_REMINDER', 'SCHEDULE_INVITE', 'SCHEDULE_UPDATE', 'SCHEDULE_CANCEL')),
	CONSTRAINT "email_message_status_check" CHECK(status IN ('QUEUED', 'SENT', 'FAILED')),
	CONSTRAINT "email_message_ics_method_check" CHECK(ics_method IS NULL OR ics_method IN ('REQUEST', 'CANCEL'))
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`website_url` text,
	`location` text,
	`timezone` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`description` text,
	`logo_file_id` text UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_event_org_id_org_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`org_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_event_logo_file_id_file_id_fk` FOREIGN KEY (`logo_file_id`) REFERENCES `file`(`id`) ON DELETE SET NULL,
	CONSTRAINT "event_status_check" CHECK(status IN ('DRAFT', 'ACTIVE', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE `event_session` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`submitter_speaker_id` text,
	`kind` text DEFAULT 'CONTENT' NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`title` text,
	`description` text,
	`visibility` text DEFAULT 'PRIVATE' NOT NULL,
	`cover_image_file_id` text UNIQUE,
	`track_id` text,
	`format_id` text,
	`room_id` text,
	`starts_at` integer,
	`ends_at` integer,
	`submitted_at` integer,
	`decided_at` integer,
	`notified_at` integer,
	`withdrawn_at` integer,
	`ics_sequence` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_event_session_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_event_session_cover_image_file_id_file_id_fk` FOREIGN KEY (`cover_image_file_id`) REFERENCES `file`(`id`) ON DELETE SET NULL,
	CONSTRAINT `event_session_track_event_fk` FOREIGN KEY (`track_id`,`event_id`) REFERENCES `track`(`id`,`event_id`),
	CONSTRAINT `event_session_format_event_fk` FOREIGN KEY (`format_id`,`event_id`) REFERENCES `format`(`id`,`event_id`),
	CONSTRAINT `event_session_room_event_fk` FOREIGN KEY (`room_id`,`event_id`) REFERENCES `room`(`id`,`event_id`),
	CONSTRAINT `event_session_submitter_event_fk` FOREIGN KEY (`submitter_speaker_id`,`event_id`) REFERENCES `speaker`(`id`,`event_id`),
	CONSTRAINT "event_session_kind_check" CHECK(kind IN ('CONTENT', 'SERVICE')),
	CONSTRAINT "event_session_status_check" CHECK(status IN ('DRAFT', 'PENDING', 'ACCEPT_QUEUE', 'ACCEPTED', 'DECLINE_QUEUE', 'DECLINED', 'WITHDRAWN')),
	CONSTRAINT "event_session_visibility_check" CHECK(visibility IN ('PUBLIC', 'PRIVATE')),
	CONSTRAINT "event_session_title_check" CHECK(status = 'DRAFT' OR (title IS NOT NULL AND length(trim(title)) > 0)),
	CONSTRAINT "event_session_time_check" CHECK((starts_at IS NULL AND ends_at IS NULL) OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE `file` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`kind` text DEFAULT 'OTHER' NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL UNIQUE,
	`uploaded_by_speaker_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_file_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_file_uploaded_by_speaker_id_speaker_id_fk` FOREIGN KEY (`uploaded_by_speaker_id`) REFERENCES `speaker`(`id`) ON DELETE SET NULL,
	CONSTRAINT "file_kind_check" CHECK(kind IN ('HEADSHOT', 'SLIDES', 'DOCUMENT', 'IMAGE', 'OTHER'))
);
--> statement-breakpoint
CREATE TABLE `form` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`purpose` text NOT NULL,
	`target` text DEFAULT 'SUBMISSION' NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`closes_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_form_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
	CONSTRAINT "form_purpose_check" CHECK(purpose IN ('CFP', 'PORTAL')),
	CONSTRAINT "form_target_check" CHECK(target IN ('SUBMISSION', 'SPEAKER')),
	CONSTRAINT "form_status_check" CHECK(status IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE `form_field_value` (
	`id` text PRIMARY KEY,
	`response_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`file_id` text,
	`subject_speaker_id` text,
	CONSTRAINT `fk_form_field_value_response_id_form_response_id_fk` FOREIGN KEY (`response_id`) REFERENCES `form_response`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_form_field_value_file_id_file_id_fk` FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_form_field_value_subject_speaker_id_speaker_id_fk` FOREIGN KEY (`subject_speaker_id`) REFERENCES `speaker`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `form_response` (
	`id` text PRIMARY KEY,
	`form_id` text NOT NULL,
	`form_version_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`session_id` text,
	`task_assignment_id` text UNIQUE,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_form_response_form_id_form_id_fk` FOREIGN KEY (`form_id`) REFERENCES `form`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_form_response_form_version_id_form_version_id_fk` FOREIGN KEY (`form_version_id`) REFERENCES `form_version`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_form_response_speaker_id_speaker_id_fk` FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_form_response_session_id_event_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `event_session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_form_response_task_assignment_id_task_assignment_id_fk` FOREIGN KEY (`task_assignment_id`) REFERENCES `task_assignment`(`id`) ON DELETE SET NULL,
	CONSTRAINT "form_response_status_check" CHECK(status IN ('DRAFT', 'SUBMITTED'))
);
--> statement-breakpoint
CREATE TABLE `form_version` (
	`id` text PRIMARY KEY,
	`form_id` text NOT NULL,
	`mdx_source` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_form_version_form_id_form_id_fk` FOREIGN KEY (`form_id`) REFERENCES `form`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `format` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`default_duration_minutes` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_format_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `org` (
	`org_id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`kind` text DEFAULT 'personal' NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_org_owner_user_id_user_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT "org_kind_check" CHECK(kind IN ('personal', 'team'))
);
--> statement-breakpoint
CREATE TABLE `org_invitation` (
	`invitation_id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_org_invitation_org_id_org_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`org_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_invitation_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `org_member` (
	`member_id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_org_member_org_id_org_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`org_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_member_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT "org_member_role_check" CHECK(role IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE `review` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`session_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`vote` text NOT NULL,
	`rating` integer,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_review_reviewer_id_user_id_fk` FOREIGN KEY (`reviewer_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `review_session_fk` FOREIGN KEY (`session_id`,`event_id`) REFERENCES `event_session`(`id`,`event_id`) ON DELETE CASCADE,
	CONSTRAINT "review_vote_check" CHECK(vote IN ('YES', 'MAYBE', 'NO')),
	CONSTRAINT "review_rating_check" CHECK(rating IS NULL OR rating BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE `room` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_room_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_participant` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`session_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`role` text DEFAULT 'SPEAKER' NOT NULL,
	`confirmation_status` text DEFAULT 'PENDING' NOT NULL,
	`confirmed_at` integer,
	`declined_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `session_participant_session_fk` FOREIGN KEY (`session_id`,`event_id`) REFERENCES `event_session`(`id`,`event_id`) ON DELETE CASCADE,
	CONSTRAINT `session_participant_speaker_fk` FOREIGN KEY (`speaker_id`,`event_id`) REFERENCES `speaker`(`id`,`event_id`) ON DELETE CASCADE,
	CONSTRAINT "session_participant_role_check" CHECK(role IN ('SPEAKER', 'MODERATOR')),
	CONSTRAINT "session_participant_confirmation_check" CHECK(confirmation_status IN ('PENDING', 'CONFIRMED', 'DECLINED'))
);
--> statement-breakpoint
CREATE TABLE `speaker` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`bio` text,
	`job_title` text,
	`company_name` text,
	`pronouns` text,
	`website_url` text,
	`linkedin_url` text,
	`twitter_url` text,
	`headshot_file_id` text UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_speaker_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_speaker_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_speaker_headshot_file_id_file_id_fk` FOREIGN KEY (`headshot_file_id`) REFERENCES `file`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `task_assignment` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`task_definition_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'NOT_STARTED' NOT NULL,
	`due_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `task_assignment_definition_fk` FOREIGN KEY (`task_definition_id`,`event_id`) REFERENCES `task_definition`(`id`,`event_id`) ON DELETE CASCADE,
	CONSTRAINT `task_assignment_speaker_fk` FOREIGN KEY (`speaker_id`,`event_id`) REFERENCES `speaker`(`id`,`event_id`) ON DELETE CASCADE,
	CONSTRAINT `task_assignment_session_fk` FOREIGN KEY (`session_id`,`event_id`) REFERENCES `event_session`(`id`,`event_id`) ON DELETE CASCADE,
	CONSTRAINT "task_assignment_status_check" CHECK(status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'))
);
--> statement-breakpoint
CREATE TABLE `task_definition` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`instructions_html` text,
	`target` text NOT NULL,
	`source` text DEFAULT 'MANUAL' NOT NULL,
	`form_id` text,
	`due_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_task_definition_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE,
	CONSTRAINT `task_definition_form_event_fk` FOREIGN KEY (`form_id`,`event_id`) REFERENCES `form`(`id`,`event_id`),
	CONSTRAINT "task_definition_target_check" CHECK(target IN ('SPEAKER', 'SUBMISSION')),
	CONSTRAINT "task_definition_source_check" CHECK(source IN ('MANUAL', 'FORM')),
	CONSTRAINT "task_definition_source_form_check" CHECK((source = 'MANUAL' AND form_id IS NULL) OR (source = 'FORM' AND form_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `track` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_track_event_id_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `email_message_event_status_idx` ON `email_message` (`event_id`,`status`);--> statement-breakpoint
CREATE INDEX `email_message_speaker_idx` ON `email_message` (`speaker_id`);--> statement-breakpoint
CREATE INDEX `email_message_session_idx` ON `email_message` (`session_id`);--> statement-breakpoint
CREATE INDEX `event_org_id_idx` ON `event` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_session_id_event_unique` ON `event_session` (`id`,`event_id`);--> statement-breakpoint
CREATE INDEX `event_session_event_status_idx` ON `event_session` (`event_id`,`status`);--> statement-breakpoint
CREATE INDEX `event_session_event_starts_idx` ON `event_session` (`event_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `event_session_event_room_starts_idx` ON `event_session` (`event_id`,`room_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `event_session_submitter_idx` ON `event_session` (`submitter_speaker_id`);--> statement-breakpoint
CREATE INDEX `event_session_track_idx` ON `event_session` (`track_id`);--> statement-breakpoint
CREATE INDEX `file_event_id_idx` ON `file` (`event_id`);--> statement-breakpoint
CREATE INDEX `file_uploaded_by_idx` ON `file` (`uploaded_by_speaker_id`);--> statement-breakpoint
CREATE INDEX `form_event_id_idx` ON `form` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `form_event_slug_unique` ON `form` (`event_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `form_id_event_unique` ON `form` (`id`,`event_id`);--> statement-breakpoint
CREATE INDEX `form_field_value_response_name_idx` ON `form_field_value` (`response_id`,`name`);--> statement-breakpoint
CREATE INDEX `form_field_value_subject_idx` ON `form_field_value` (`subject_speaker_id`);--> statement-breakpoint
CREATE INDEX `form_field_value_file_idx` ON `form_field_value` (`file_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `form_field_value_plain_unique` ON `form_field_value` (`response_id`,`name`,`value`) WHERE subject_speaker_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `form_field_value_subject_unique` ON `form_field_value` (`response_id`,`name`,`value`,`subject_speaker_id`) WHERE subject_speaker_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `form_response_form_status_idx` ON `form_response` (`form_id`,`status`);--> statement-breakpoint
CREATE INDEX `form_response_version_idx` ON `form_response` (`form_version_id`);--> statement-breakpoint
CREATE INDEX `form_response_speaker_idx` ON `form_response` (`speaker_id`);--> statement-breakpoint
CREATE INDEX `form_response_session_idx` ON `form_response` (`session_id`);--> statement-breakpoint
CREATE INDEX `form_version_form_created_idx` ON `form_version` (`form_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `format_event_id_idx` ON `format` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `format_event_name_unique` ON `format` (`event_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `format_id_event_unique` ON `format` (`id`,`event_id`);--> statement-breakpoint
CREATE INDEX `org_owner_user_id_idx` ON `org` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_owner_personal_unique` ON `org` (`owner_user_id`) WHERE kind = 'personal';--> statement-breakpoint
CREATE INDEX `org_invitation_org_id_idx` ON `org_invitation` (`org_id`);--> statement-breakpoint
CREATE INDEX `org_member_org_id_idx` ON `org_member` (`org_id`);--> statement-breakpoint
CREATE INDEX `org_member_user_id_idx` ON `org_member` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_member_org_id_user_id_unique` ON `org_member` (`org_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_session_reviewer_unique` ON `review` (`session_id`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `review_reviewer_idx` ON `review` (`reviewer_id`);--> statement-breakpoint
CREATE INDEX `review_event_idx` ON `review` (`event_id`);--> statement-breakpoint
CREATE INDEX `room_event_id_idx` ON `room` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_event_name_unique` ON `room` (`event_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_id_event_unique` ON `room` (`id`,`event_id`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_participant_session_speaker_unique` ON `session_participant` (`session_id`,`speaker_id`);--> statement-breakpoint
CREATE INDEX `session_participant_speaker_idx` ON `session_participant` (`speaker_id`);--> statement-breakpoint
CREATE INDEX `speaker_event_id_idx` ON `speaker` (`event_id`);--> statement-breakpoint
CREATE INDEX `speaker_user_id_idx` ON `speaker` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_event_email_unique` ON `speaker` (`event_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_id_event_unique` ON `speaker` (`id`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_event_user_unique` ON `speaker` (`event_id`,`user_id`) WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `task_assignment_definition_status_idx` ON `task_assignment` (`task_definition_id`,`status`);--> statement-breakpoint
CREATE INDEX `task_assignment_speaker_status_idx` ON `task_assignment` (`speaker_id`,`status`);--> statement-breakpoint
CREATE INDEX `task_assignment_session_idx` ON `task_assignment` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_assignment_speaker_unique` ON `task_assignment` (`task_definition_id`,`speaker_id`) WHERE session_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `task_assignment_session_unique` ON `task_assignment` (`task_definition_id`,`speaker_id`,`session_id`) WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `task_definition_id_event_unique` ON `task_definition` (`id`,`event_id`);--> statement-breakpoint
CREATE INDEX `task_definition_event_idx` ON `task_definition` (`event_id`);--> statement-breakpoint
CREATE INDEX `task_definition_form_idx` ON `task_definition` (`form_id`);--> statement-breakpoint
CREATE INDEX `track_event_id_idx` ON `track` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `track_event_name_unique` ON `track` (`event_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `track_id_event_unique` ON `track` (`id`,`event_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);