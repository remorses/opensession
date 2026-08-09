-- Phase 5 publication state is independent from the event and CFP lifecycle.
ALTER TABLE `event` ADD COLUMN `program_published_at` integer;
