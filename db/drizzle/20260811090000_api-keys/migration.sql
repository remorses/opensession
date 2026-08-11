-- Add event-scoped API keys. Raw secrets are never stored.
CREATE TABLE api_key (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  event_id text NOT NULL,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  created_by_user_id text,
  last_used_at integer,
  expires_at integer,
  revoked_at integer,
  created_at integer NOT NULL,
  CONSTRAINT api_key_event_org_fk FOREIGN KEY (event_id, org_id)
    REFERENCES event(id, org_id) ON DELETE CASCADE,
  CONSTRAINT fk_api_key_created_by_user_id_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES user(id) ON DELETE SET NULL
);
CREATE INDEX api_key_event_id_idx ON api_key (event_id);
CREATE INDEX api_key_org_id_idx ON api_key (org_id);
CREATE INDEX api_key_created_by_idx ON api_key (created_by_user_id);

CREATE TABLE api_key_scope (
  api_key_id text NOT NULL,
  scope text NOT NULL,
  PRIMARY KEY (api_key_id, scope),
  CONSTRAINT fk_api_key_scope_api_key_id_api_key_id_fk FOREIGN KEY (api_key_id)
    REFERENCES api_key(id) ON DELETE CASCADE,
  CONSTRAINT api_key_scope_check CHECK(scope IN (
    'read:events', 'write:events',
    'read:sessions', 'write:sessions',
    'read:speakers', 'write:speakers',
    'read:metadata', 'write:metadata',
    'read:reviews'
  ))
);
