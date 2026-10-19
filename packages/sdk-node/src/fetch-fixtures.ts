/** Review projections before persisting fixtures. Never return credentials or customer data. */
export interface FetchFixture {
  status: number;
  body: string;
}
function validate(fixture: FetchFixture): FetchFixture {
  if (
    !Number.isInteger(fixture.status) ||
    fixture.status < 200 ||
    fixture.status > 599 ||
    ([204, 205, 304].includes(fixture.status) && fixture.body !== '') ||
    typeof fixture.body !== 'string' ||
    Buffer.byteLength(fixture.body) > 16_384
  )
    throw new Error('Invalid HTTP fixture');
  return { status: fixture.status, body: fixture.body };
}

/** Records only an explicitly projected clone; the original response stays readable. */
export function createFetchRecording(options: {
  fetch?: typeof globalThis.fetch;
  project(response: Response): Promise<FetchFixture>;
}) {
  const fixtures: FetchFixture[] = [];
  const implementation = options.fetch ?? globalThis.fetch;
  let complete = true;
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const index = fixtures.length;
    if (index >= 100) {
      complete = false;
      return implementation(input, init);
    }
    // Reserve invocation order, including concurrent calls.
    fixtures.push({ status: 200, body: '' });
    pending++;
    try {
      const response = await implementation(input, init);
      try {
        fixtures[index] = validate(await options.project(response.clone()));
      } catch {
        complete = false;
      }
      return response;
    } catch (error) {
      complete = false;
      throw error;
    } finally {
      pending--;
    }
  };
  return {
    fetch,
    snapshot(): FetchFixture[] {
      if (!complete || pending) throw new Error('Incomplete HTTP recording');
      return fixtures.map(validate);
    },
  };
}

/** A single reviewed dependency/operation's ordered responses, with no network fallback. */
export function createFetchReplay(input: readonly FetchFixture[]) {
  if (input.length > 100) throw new Error('Too many HTTP fixtures');
  const fixtures = input.map(validate);
  let index = 0;
  const fetch: typeof globalThis.fetch = async () => {
    const fixture = fixtures[index++];
    if (!fixture) throw new Error('Unexpected HTTP dependency call');
    return new Response(fixture.body === '' ? null : fixture.body, {
      status: fixture.status,
    });
  };
  return {
    fetch,
    assertComplete(): void {
      if (index !== fixtures.length)
        throw new Error('HTTP dependency calls differ from recording');
    },
  };
}
