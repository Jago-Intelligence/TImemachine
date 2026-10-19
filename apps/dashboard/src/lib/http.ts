export async function readLoginForm(
  request: Request,
): Promise<URLSearchParams | undefined> {
  if (
    !request.headers
      .get('content-type')
      ?.startsWith('application/x-www-form-urlencoded') ||
    Number(request.headers.get('content-length') ?? '0') > 4096 ||
    !request.body
  )
    return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
