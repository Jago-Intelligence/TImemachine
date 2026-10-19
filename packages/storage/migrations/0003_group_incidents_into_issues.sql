ALTER TABLE "timemachine_incidents" ADD COLUMN "issue_id" varchar(64);
--> statement-breakpoint
-- Identity v1 uses UTF-8 byte-length-prefixed fields, matching src/issues.ts.
UPDATE timemachine_incidents AS i SET issue_id = (
  SELECT encode(sha256(convert_to(string_agg(
    octet_length(convert_to(part.value, 'UTF8'))::text || ':' || part.value,
    '|' ORDER BY part.ordinality
  ), 'UTF8')), 'hex')
  FROM unnest(ARRAY[
    'v1',
    i.payload #>> '{service,name}',
    i.payload #>> '{service,environment}',
    coalesce((SELECT event->>'method' FROM jsonb_array_elements(i.payload->'timeline') WITH ORDINALITY AS e(event, ordinal)
      WHERE event->>'type' = 'http.request' ORDER BY ordinal LIMIT 1), ''),
    coalesce((SELECT event->>'route' FROM jsonb_array_elements(i.payload->'timeline') WITH ORDINALITY AS e(event, ordinal)
      WHERE event->>'type' = 'http.request' ORDER BY ordinal LIMIT 1), ''),
    coalesce(i.payload #>> '{failure,code}', ''),
    i.payload #>> '{failure,name}',
    i.payload #>> '{failure,source}',
    coalesce(i.payload #>> '{failure,frames,0,file}', ''),
    coalesce(i.payload #>> '{failure,frames,0,line}', '')
  ]) WITH ORDINALITY AS part(value, ordinality)
);
--> statement-breakpoint
ALTER TABLE "timemachine_incidents" ALTER COLUMN "issue_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "timemachine_incidents_issue_idx" ON "timemachine_incidents" USING btree ("issue_id","occurred_at","id");
