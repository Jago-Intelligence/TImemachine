import { replayRequestSchema, type ReplayExpectation } from '@timemachine/core';
import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../lib/auth';
import {
  getReplayInfo,
  startReplay,
  CollectorUnavailable,
} from '../../../../../lib/collector';
const validId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSession();
  const { id } = await params;
  if (!validId(id))
    return NextResponse.json({ error: 'Invalid incident' }, { status: 400 });
  try {
    return NextResponse.json(await getReplayInfo(id));
  } catch (error) {
    if (!(error instanceof CollectorUnavailable)) throw error;
    return NextResponse.json(
      { error: 'Replay information unavailable' },
      { status: error.status },
    );
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const config = await requireSession();
  if (request.headers.get('origin') !== config.origin)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  if (
    !validId(id) ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  let mode: 'captured' | 'current';
  let target: ReplayExpectation | undefined;
  try {
    if (!request.body) throw new Error('Missing body');
    const reader = request.body.getReader();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > 512) {
          await reader.cancel();
          throw new Error('Body too large');
        }
        text += new TextDecoder().decode(value.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(text);
    const parsed = replayRequestSchema.parse(body);
    mode = parsed.mode;
    target = parsed.target;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    return NextResponse.json(await startReplay(id, mode, target), { status: 201 });
  } catch (error) {
    if (!(error instanceof CollectorUnavailable)) throw error;
    return NextResponse.json(
      {
        error:
          error.code === 'REPLAY_SCENARIO_CHANGED'
            ? 'The test scenario changed between builds. Keep the original scenario contract while changing application code.'
            : error.status === 409
              ? 'Replay unavailable or another replay is running. Refresh and retry.'
              : 'Replay runner unavailable. Check Docker and replay configuration.',
      },
      { status: error.status },
    );
  }
}
