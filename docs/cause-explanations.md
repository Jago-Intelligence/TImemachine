# Failure explanations

TimeMachine connects approved source facts with recorded dependency data. The incident
page separates three outcomes:

| Outcome               | What it means                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Failure explanation   | A supported source expression matches one recorded response and an incompatible field value/type.                       |
| Dependency evidence   | HTTP or PostgreSQL failures were observed during the request, but are not linked as the cause of the application error. |
| Failure investigation | The capture does not contain enough supported evidence to explain the failure.                                          |

There is no AI provider, source-code upload, automatic patch or guarantee that every
failure has a known root cause. A nearby dependency failure is never promoted to a
source-linked explanation just because it happened in the same request.

## Missing, null and wrong-type fields

For a captured `TypeError`, the source inspector recognizes `.toFixed()` on numeric
fields and `.trim()`, `.toLowerCase()` and `.toUpperCase()` on string fields. Dot
properties, literal bracket keys and uniquely declared constant bracket keys are
supported. Fields must pass the same sensitive-name restrictions as recordings.

A source-linked explanation requires:

- An approved startup source snapshot and matching captured error frame.
- A supported binding to exactly one HTTP response or PostgreSQL query result.
- A complete recorded object/first row and no truncated recording.
- A field that is absent, null or the wrong primitive type for the operation.

The card shows the structured expression, location, recorded field type, available
field names and snapshot hash. It does not display field values or choose a
replacement field. A missing property evaluates to `undefined`; a null value or an
incompatible primitive type also explains why the recognized method call fails.
These are explanations of a specific captured pattern, not proof of the underlying
business cause or of every runtime state outside the recording.

## Supported HTTP bindings

Examples below illustrate source patterns; normal recording policy and SDK setup
are still required. Imports and real clients remain in your application.

```js
const response = await fetch('https://pricing.example.com/rates');
const pricing = await response.json();
const rate = pricing.ratePerUnit.toFixed(2);
```

The complete recording might contain a numeric `rate` field but no `ratePerUnit`.
The explanation then identifies the absent field, rather than guessing a code fix.

Direct Axios imports and simple instances are also supported:

```js
import axios from 'axios';

const response = await axios.get('https://pricing.example.com/rates');
const rate = response.data.ratePerUnit.toFixed(2);
```

The equivalent `const { data: pricing } = await axios.get(...)` pattern is supported.
A simple `axios.create({ baseURL: 'https://pricing.example.com' })` instance with a
literal `/rates` path is supported. The inspector does not resolve arbitrary injected
clients, dynamic URLs, transform/interceptor pipelines or general JavaScript aliases.
Inline bindings must be constant, in the same block and before the failing call.
Mutations, object aliases, escapes into other function calls and ambiguous recorded
matches are rejected. Native fetch supports GET with no options or a literal options
object containing a cancellation signal and/or literal `method: 'GET'`.

The existing same-file helper pattern also remains supported: a named function's
first parameter receives `await result.json()` directly, where `result` comes from
a literal `globalThis.fetch(...)` call.

## PostgreSQL fields and errors

Approved source can bind `const result = await database.query(SQL, values)`,
`const row = result.rows[0]`, then `row.rate.toFixed(...)` (or an approved bracket
key). Literal SQL or a uniquely declared constant must normalize to exactly one
recorded query fingerprint. Missing, null and wrong-type columns can then be
explained. An empty result is not treated as a missing column.

Separately, recorded PostgreSQL errors show their captured error code and a fixed
meaning for recognized SQLSTATE/connection codes, such as `42703` (undefined column)
or `23505` (unique constraint violation). Query text, database exception messages,
parameter values and constraint names are not added to the explanation. A code does
not identify the specific column or establish the application error's cause without
further evidence.

Recorded HTTP error statuses and transport failures are similarly shown as dependency
observations. A transport failure without a recorded reason is not labelled as DNS,
timeout or connection refusal. Incomplete recordings explicitly state their limited
coverage.

## Enable source evidence

Add the application file to your existing recording policy:

```json
{
  "sourceEvidenceFiles": ["src/app.js"]
}
```

This fragment is not a complete policy. For manual SDK initialization, set
`sourceEvidenceFiles` and an absolute `sourceRoot`. Files are snapshotted at startup,
limited to five approved files of 128 KiB each. Paths/symlinks outside the source root
are rejected. Source syntax is analyzed without executing it; only structured facts
and a source hash are sent, not source text or runtime variable dumps.

Restart the recording backend and capture a new failure to use expanded source
bindings. Existing incidents cannot gain source facts that were never captured.
Editing source later does not rewrite a historical snapshot. A source hash is not
cryptographic attestation of the running build; align recordings with the registered
application image.

## Verify the change

Review the failure explanation and response contract, change your application code,
then replay the original request against the updated build. A successful response
and passing business assertions verify that saved scenario. Resolution remains an
explicit decision and does not prove that every related request is fixed.
