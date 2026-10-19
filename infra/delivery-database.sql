CREATE TABLE delivery_zones (
  zone_code text PRIMARY KEY,
  rate_per_km integer NOT NULL CHECK (rate_per_km > 0),
  currency text NOT NULL
);
INSERT INTO delivery_zones (zone_code, rate_per_km, currency)
VALUES ('LOCAL', 2, 'USD'), ('EXPRESS', 4, 'USD');

CREATE TABLE IF NOT EXISTS test_users (id SERIAL PRIMARY KEY, handle TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS registration_audit (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES test_users(id), action TEXT NOT NULL);
