CREATE TABLE "timemachine_issue_states" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	CONSTRAINT "timemachine_issue_states_revision_check" CHECK ("timemachine_issue_states"."revision" > 0),
	CONSTRAINT "timemachine_issue_states_status_check" CHECK ("timemachine_issue_states"."status" IN ('open', 'resolved'))
);

--> statement-breakpoint
INSERT INTO timemachine_issue_states (id, revision)
SELECT issue_id, count(*) FROM timemachine_incidents GROUP BY issue_id;
