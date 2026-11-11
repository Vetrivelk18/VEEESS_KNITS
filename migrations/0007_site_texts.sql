-- Shop texts edited by admins (D50). Only changed texts are stored; anything missing
-- uses the default wording in shared/siteText.ts. The shop picks them up on "Publish storefront".
CREATE TABLE site_texts (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 3 AND 60),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 1000),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
