CREATE TABLE "timemachine_alert_outbox" (
	"id" varchar(96) PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease" uuid,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	CONSTRAINT "timemachine_alert_attempts_check" CHECK ("timemachine_alert_outbox"."attempts" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE INDEX "timemachine_alert_due_idx" ON "timemachine_alert_outbox" USING btree ("due_at");