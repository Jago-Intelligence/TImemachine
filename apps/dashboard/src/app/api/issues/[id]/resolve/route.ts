import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '../../../../../lib/auth';
import { resolveIssue, CollectorUnavailable } from '../../../../../lib/collector';
const schema = z.strictObject({
  incidentId: z.uuid(),
  runId: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const config = await requireSession();
  if (request.headers.get('origin') !== config.origin)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  if (
    !/^[a-f0-9]{64}$/.test(id) ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  let input: z.infer<typeof schema>;
  try {
    if (!request.body) throw new Error('Missing body');
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '',
      bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 512) {
          await reader.cancel();
          throw new Error('Too large');
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    input = schema.parse(JSON.parse(text));
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    return NextResponse.json(await resolveIssue(id, input));
  } catch (error) {
    if (!(error instanceof CollectorUnavailable)) throw error;
    return NextResponse.json(
      {
        error: 'Resolution unavailable. Refresh the issue and verify its current state.',
      },
      { status: error.status },
    );
  }
}
