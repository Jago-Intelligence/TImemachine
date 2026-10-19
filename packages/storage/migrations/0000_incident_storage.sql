CREATE TABLE "timemachine_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"service_name" varchar(128) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "timemachine_incidents_schema_check" CHECK ("timemachine_incidents"."schema_version" = 1),
	CONSTRAINT "timemachine_incidents_expiry_check" CHECK ("timemachine_incidents"."expires_at" > "timemachine_incidents"."received_at")
);
--> statement-breakpoint
CREATE INDEX "timemachine_incidents_received_idx" ON "timemachine_incidents" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "timemachine_incidents_expiry_idx" ON "timemachine_incidents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "timemachine_incidents_service_idx" ON "timemachine_incidents" USING btree ("service_name","occurred_at");