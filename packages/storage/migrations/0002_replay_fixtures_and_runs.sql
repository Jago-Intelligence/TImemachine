CREATE TABLE "timemachine_replay_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" varchar(32) NOT NULL,
	"slot" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "timemachine_replay_slot_check" CHECK ("timemachine_replay_runs"."slot" = 1),
	CONSTRAINT "timemachine_replay_status_check" CHECK ("timemachine_replay_runs"."status" IN ('running', 'reproduced', 'not-reproduced', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "timemachine_incidents" ADD COLUMN "replay_fixture" jsonb;--> statement-breakpoint
ALTER TABLE "timemachine_replay_runs" ADD CONSTRAINT "timemachine_replay_runs_incident_id_timemachine_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."timemachine_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timemachine_replay_history_idx" ON "timemachine_replay_runs" USING btree ("incident_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "timemachine_replay_running_idx" ON "timemachine_replay_runs" USING btree ("slot") WHERE "timemachine_replay_runs"."status" = 'running';