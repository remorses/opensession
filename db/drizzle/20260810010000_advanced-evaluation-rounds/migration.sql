-- Restore form-backed evaluation rounds after the deployed simple-review schema.
-- Existing quick reviews become submitted responses in one imported round per event.
PRAGMA defer_foreign_keys = ON;

CREATE UNIQUE INDEX IF NOT EXISTS event_id_org_unique ON event (id, org_id);

-- Field values cascade from form responses, so detach them before dropping
-- the response table. This preserves CFP and portal answers across the rebuild.
CREATE TABLE __detached_form_field_value AS
SELECT id, response_id, name, value, file_id, subject_speaker_id
FROM form_field_value;
DROP TABLE form_field_value;

-- Form responses reference both form and form_version with restrictive FKs.
-- Detach their data before either parent is rebuilt.
CREATE TABLE __detached_form_response AS
SELECT
  id, event_id, form_id, form_version_id, speaker_id, session_id,
  task_assignment_id, status, submitted_at, created_at, updated_at
FROM form_response;
DROP TABLE form_response;

-- Keep form versions alive while form is rebuilt. Its cascading FK would
-- otherwise delete every CFP and portal version when the old form table drops.
CREATE TABLE __detached_form_version (
  id text PRIMARY KEY NOT NULL,
  form_id text NOT NULL,
  mdx_source text NOT NULL,
  created_at integer NOT NULL
);
INSERT INTO __detached_form_version SELECT id, form_id, mdx_source, created_at FROM form_version;
DROP TABLE form_version;

CREATE TABLE __new_form (
  id text PRIMARY KEY NOT NULL,
  event_id text NOT NULL,
  purpose text NOT NULL,
  target text DEFAULT 'SUBMISSION' NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  status text DEFAULT 'DRAFT' NOT NULL,
  opens_at integer,
  closes_at integer,
  blind integer DEFAULT false NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT fk_form_event_id_event_id_fk FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE,
  CONSTRAINT form_purpose_check CHECK(purpose IN ('CFP', 'PORTAL', 'EVALUATION')),
  CONSTRAINT form_target_check CHECK(target IN ('SUBMISSION', 'SPEAKER')),
  CONSTRAINT form_status_check CHECK(status IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'))
);
INSERT INTO __new_form (
  id, event_id, purpose, target, name, slug, status,
  opens_at, closes_at, blind, created_at, updated_at
)
SELECT
  id, event_id, purpose, target, name, slug, status,
  opens_at, closes_at, 0, created_at, updated_at
FROM form;
DROP TABLE form;
ALTER TABLE __new_form RENAME TO form;
CREATE INDEX form_event_id_idx ON form (event_id);
CREATE UNIQUE INDEX form_event_slug_unique ON form (event_id, slug);
CREATE UNIQUE INDEX form_id_event_unique ON form (id, event_id);

CREATE TABLE form_version (
  id text PRIMARY KEY NOT NULL,
  form_id text NOT NULL,
  mdx_source text NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT fk_form_version_form_id_form_id_fk FOREIGN KEY (form_id) REFERENCES form(id) ON DELETE CASCADE
);
INSERT INTO form_version SELECT id, form_id, mdx_source, created_at FROM __detached_form_version;
DROP TABLE __detached_form_version;
CREATE INDEX form_version_form_created_idx ON form_version (form_id, created_at);
CREATE UNIQUE INDEX form_version_id_form_unique ON form_version (id, form_id);

CREATE TABLE __new_org_invitation (
  invitation_id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  purpose text DEFAULT 'ORG_MEMBER' NOT NULL,
  role text DEFAULT 'member' NOT NULL,
  invited_email text,
  event_id text,
  form_id text,
  created_by text NOT NULL,
  expires_at integer NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT fk_org_invitation_org_id_org_org_id_fk FOREIGN KEY (org_id) REFERENCES org(org_id) ON DELETE CASCADE,
  CONSTRAINT fk_org_invitation_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES user(id) ON DELETE CASCADE,
  CONSTRAINT org_invitation_event_org_fk FOREIGN KEY (event_id, org_id) REFERENCES event(id, org_id) ON DELETE CASCADE,
  CONSTRAINT org_invitation_form_event_fk FOREIGN KEY (form_id, event_id) REFERENCES form(id, event_id) ON DELETE CASCADE,
  CONSTRAINT org_invitation_purpose_check CHECK(purpose IN ('ORG_MEMBER', 'EVALUATION_REVIEWER')),
  CONSTRAINT org_invitation_owner_check CHECK(
    (purpose = 'ORG_MEMBER' AND invited_email IS NULL AND event_id IS NULL AND form_id IS NULL)
    OR
    (purpose = 'EVALUATION_REVIEWER' AND invited_email IS NOT NULL AND event_id IS NOT NULL AND form_id IS NOT NULL)
  )
);
INSERT INTO __new_org_invitation (
  invitation_id, org_id, purpose, role, created_by, expires_at, created_at
)
SELECT invitation_id, org_id, 'ORG_MEMBER', role, created_by, expires_at, created_at
FROM org_invitation;
DROP TABLE org_invitation;
ALTER TABLE __new_org_invitation RENAME TO org_invitation;
CREATE INDEX org_invitation_org_id_idx ON org_invitation (org_id);
CREATE INDEX org_invitation_form_idx ON org_invitation (form_id);

-- Preserve the deployed quick-review values before replacing their table.
CREATE TABLE __simple_review_values AS
SELECT id, event_id, session_id, reviewer_id, vote, rating, comment, created_at, updated_at
FROM review;

INSERT INTO form (
  id, event_id, purpose, target, name, slug, status, blind, created_at, updated_at
)
SELECT
  'imported-evaluation-' || event_id,
  event_id,
  'EVALUATION',
  'SUBMISSION',
  'Imported quick reviews',
  'imported-quick-reviews',
  'CLOSED',
  0,
  min(created_at),
  max(updated_at)
FROM __simple_review_values
GROUP BY event_id;

INSERT INTO form_version (id, form_id, mdx_source, created_at)
SELECT
  'imported-evaluation-version-' || event_id,
  'imported-evaluation-' || event_id,
  '# Imported quick review scorecard

<Select name="vote" label="Vote" options={["Yes", "Maybe", "No"]} required />

<Number name="rating" label="Rating" min={1} max={5} weight={1} />

<RichText name="comment" label="Comment" maxLength={5000} />',
  min(created_at)
FROM __simple_review_values
GROUP BY event_id;

CREATE TABLE evaluation_reviewer (
  id text PRIMARY KEY NOT NULL,
  event_id text NOT NULL,
  form_id text NOT NULL,
  user_id text NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT fk_evaluation_reviewer_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  CONSTRAINT evaluation_reviewer_form_event_fk FOREIGN KEY (form_id, event_id) REFERENCES form(id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX evaluation_reviewer_form_user_unique ON evaluation_reviewer (form_id, user_id);
CREATE UNIQUE INDEX evaluation_reviewer_event_form_user_unique ON evaluation_reviewer (event_id, form_id, user_id);
CREATE INDEX evaluation_reviewer_user_idx ON evaluation_reviewer (user_id);
CREATE INDEX evaluation_reviewer_event_idx ON evaluation_reviewer (event_id);

INSERT INTO evaluation_reviewer (id, event_id, form_id, user_id, created_at)
SELECT
  'imported-evaluation-reviewer-' || event_id || '-' || reviewer_id,
  event_id,
  'imported-evaluation-' || event_id,
  reviewer_id,
  min(created_at)
FROM __simple_review_values
GROUP BY event_id, reviewer_id;

DROP TABLE review;
CREATE TABLE review (
  id text PRIMARY KEY NOT NULL,
  event_id text NOT NULL,
  form_id text NOT NULL,
  session_id text NOT NULL,
  reviewer_id text NOT NULL,
  recused_at integer,
  recusal_reason text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT fk_review_reviewer_id_user_id_fk FOREIGN KEY (reviewer_id) REFERENCES user(id) ON DELETE CASCADE,
  CONSTRAINT review_session_fk FOREIGN KEY (session_id, event_id) REFERENCES event_session(id, event_id) ON DELETE CASCADE,
  CONSTRAINT review_form_event_fk FOREIGN KEY (form_id, event_id) REFERENCES form(id, event_id) ON DELETE CASCADE,
  CONSTRAINT review_pool_fk FOREIGN KEY (event_id, form_id, reviewer_id) REFERENCES evaluation_reviewer(event_id, form_id, user_id) ON DELETE CASCADE,
  CONSTRAINT review_recusal_check CHECK(
    (recused_at IS NULL AND recusal_reason IS NULL)
    OR
    (recused_at IS NOT NULL AND recusal_reason IS NOT NULL AND length(trim(recusal_reason)) > 0)
  )
);
INSERT INTO review (id, event_id, form_id, session_id, reviewer_id, created_at, updated_at)
SELECT
  id,
  event_id,
  'imported-evaluation-' || event_id,
  session_id,
  reviewer_id,
  created_at,
  updated_at
FROM __simple_review_values;
CREATE UNIQUE INDEX review_form_session_reviewer_unique ON review (form_id, session_id, reviewer_id);
CREATE UNIQUE INDEX review_id_form_event_unique ON review (id, form_id, event_id);
CREATE INDEX review_reviewer_idx ON review (reviewer_id);
CREATE INDEX review_event_form_idx ON review (event_id, form_id);
CREATE INDEX review_session_idx ON review (session_id);

CREATE TABLE __new_form_response (
  id text PRIMARY KEY NOT NULL,
  event_id text NOT NULL,
  form_id text NOT NULL,
  form_version_id text NOT NULL,
  speaker_id text,
  review_id text UNIQUE,
  session_id text,
  task_assignment_id text UNIQUE,
  status text DEFAULT 'DRAFT' NOT NULL,
  submitted_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT form_response_form_event_fk FOREIGN KEY (form_id, event_id) REFERENCES form(id, event_id) ON DELETE RESTRICT,
  CONSTRAINT form_response_version_form_fk FOREIGN KEY (form_version_id, form_id) REFERENCES form_version(id, form_id) ON DELETE RESTRICT,
  CONSTRAINT fk_form_response_speaker_id_speaker_id_fk FOREIGN KEY (speaker_id) REFERENCES speaker(id) ON DELETE RESTRICT,
  CONSTRAINT form_response_review_form_event_fk FOREIGN KEY (review_id, form_id, event_id) REFERENCES review(id, form_id, event_id) ON DELETE CASCADE,
  CONSTRAINT fk_form_response_session_id_event_session_id_fk FOREIGN KEY (session_id) REFERENCES event_session(id) ON DELETE CASCADE,
  CONSTRAINT fk_form_response_task_assignment_id_task_assignment_id_fk FOREIGN KEY (task_assignment_id) REFERENCES task_assignment(id) ON DELETE SET NULL,
  CONSTRAINT form_response_owner_check CHECK(
    (speaker_id IS NOT NULL AND review_id IS NULL)
    OR
    (speaker_id IS NULL AND review_id IS NOT NULL)
  ),
  CONSTRAINT form_response_status_check CHECK(status IN ('DRAFT', 'SUBMITTED'))
);
INSERT INTO __new_form_response (
  id, event_id, form_id, form_version_id, speaker_id, session_id,
  task_assignment_id, status, submitted_at, created_at, updated_at
)
SELECT
  id, event_id, form_id, form_version_id, speaker_id, session_id,
  task_assignment_id, status, submitted_at, created_at, updated_at
FROM __detached_form_response;
DROP TABLE __detached_form_response;
ALTER TABLE __new_form_response RENAME TO form_response;
CREATE INDEX form_response_form_status_idx ON form_response (form_id, status);
CREATE INDEX form_response_version_idx ON form_response (form_version_id);
CREATE INDEX form_response_speaker_idx ON form_response (speaker_id);
CREATE INDEX form_response_event_idx ON form_response (event_id);
CREATE INDEX form_response_session_idx ON form_response (session_id);
CREATE UNIQUE INDEX form_response_active_draft_unique
  ON form_response (form_id, speaker_id)
  WHERE status = 'DRAFT' AND speaker_id IS NOT NULL;

CREATE TABLE form_field_value (
  id text PRIMARY KEY NOT NULL,
  response_id text NOT NULL,
  name text NOT NULL,
  value text NOT NULL,
  file_id text,
  subject_speaker_id text,
  CONSTRAINT fk_form_field_value_response_id_form_response_id_fk FOREIGN KEY (response_id) REFERENCES form_response(id) ON DELETE CASCADE,
  CONSTRAINT fk_form_field_value_file_id_file_id_fk FOREIGN KEY (file_id) REFERENCES file(id) ON DELETE SET NULL,
  CONSTRAINT fk_form_field_value_subject_speaker_id_speaker_id_fk FOREIGN KEY (subject_speaker_id) REFERENCES speaker(id) ON DELETE RESTRICT
);
INSERT INTO form_field_value (id, response_id, name, value, file_id, subject_speaker_id)
SELECT id, response_id, name, value, file_id, subject_speaker_id
FROM __detached_form_field_value;
DROP TABLE __detached_form_field_value;
CREATE INDEX form_field_value_response_name_idx ON form_field_value (response_id, name);
CREATE INDEX form_field_value_subject_idx ON form_field_value (subject_speaker_id);
CREATE INDEX form_field_value_file_idx ON form_field_value (file_id);
CREATE UNIQUE INDEX form_field_value_plain_unique
  ON form_field_value (response_id, name, value)
  WHERE subject_speaker_id IS NULL;
CREATE UNIQUE INDEX form_field_value_subject_unique
  ON form_field_value (response_id, name, value, subject_speaker_id)
  WHERE subject_speaker_id IS NOT NULL;

INSERT INTO form_response (
  id, event_id, form_id, form_version_id, review_id, session_id,
  status, submitted_at, created_at, updated_at
)
SELECT
  'imported-evaluation-response-' || id,
  event_id,
  'imported-evaluation-' || event_id,
  'imported-evaluation-version-' || event_id,
  id,
  session_id,
  'SUBMITTED',
  updated_at,
  created_at,
  updated_at
FROM __simple_review_values;

INSERT INTO form_field_value (id, response_id, name, value)
SELECT
  'imported-evaluation-vote-' || id,
  'imported-evaluation-response-' || id,
  'vote',
  CASE vote WHEN 'YES' THEN 'Yes' WHEN 'MAYBE' THEN 'Maybe' ELSE 'No' END
FROM __simple_review_values;

INSERT INTO form_field_value (id, response_id, name, value)
SELECT
  'imported-evaluation-rating-' || id,
  'imported-evaluation-response-' || id,
  'rating',
  CAST(rating AS text)
FROM __simple_review_values
WHERE rating IS NOT NULL;

INSERT INTO form_field_value (id, response_id, name, value)
SELECT
  'imported-evaluation-comment-' || id,
  'imported-evaluation-response-' || id,
  'comment',
  comment
FROM __simple_review_values
WHERE comment IS NOT NULL AND length(trim(comment)) > 0;

DROP TABLE __simple_review_values;

PRAGMA defer_foreign_keys = OFF;
