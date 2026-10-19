CREATE TABLE "timemachine_workspace" (
  "id" integer PRIMARY KEY NOT NULL CHECK ("id" = 1),
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "document" text NOT NULL CHECK (octet_length("document") <= 524288)
);
