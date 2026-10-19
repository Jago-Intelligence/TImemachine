CREATE TABLE "timemachine_notification_settings" (
  "id" integer PRIMARY KEY NOT NULL CHECK ("id" = 1),
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "ciphertext" text NOT NULL CHECK (length("ciphertext") <= 32768)
);
