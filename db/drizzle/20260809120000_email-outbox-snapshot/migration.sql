-- Reply-To address for every outbound email of an event. Seeded from the event
-- creator's account email at createEvent, editable in Settings > Details.
-- NULL falls back to the platform sender address.
ALTER TABLE `event` ADD `contact_email` text;

-- Plain-text alternative, snapshotted next to body_html at enqueue time.
ALTER TABLE `email_message` ADD `body_text` text;

-- Rendered iCalendar snapshot. The outbox row must be self-contained: a retry
-- days after enqueue has to send the EXACT invite that was queued, because it
-- carries the SEQUENCE snapshotted with it. Regenerating from the live session
-- would ship changed times under a stale SEQUENCE, which clients drop.
ALTER TABLE `email_message` ADD `ics_body` text;
