import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INCIDENT_LIMITS, stackFrameSchema, type Failure } from '@timemachine/core';
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;

/** Opt-in extraction: only project-relative locations leave the process. */
export function projectFrames(
  error: unknown,
  root: string | undefined,
): Failure['frames'] {
  if (!root) return [];
  try {
    if (!(error instanceof Error)) return [];
    // Avoid invoking application-defined stack/name/message getters.
    let object: object | null = error;
    for (let depth = 0; object && depth < 20; depth++) {
      for (const key of ['name', 'message']) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (
          descriptor &&
          (!('value' in descriptor) || typeof descriptor.value !== 'string')
        )
          return [];
      }
      object = Object.getPrototypeOf(object) as object | null;
    }
    if (object) return [];
    const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
    const stack: unknown =
      descriptor && 'value' in descriptor
        ? descriptor.value
        : descriptor?.get === nativeStackGetter
          ? nativeStackGetter?.call(error)
          : undefined;
    if (typeof stack !== 'string' || stack.length > 65536) return [];
    const frames: Failure['frames'] = [];
    for (const line of stack.split('\n').slice(1, 101)) {
      const match = /^\s*at (?:.* \()?((?:file:\/\/\/|\/)[^\n]+):(\d+):(\d+)\)?$/.exec(
        line,
      );
      if (!match) continue;
      const absolute = match[1]!.startsWith('file:')
        ? fileURLToPath(match[1]!)
        : match[1]!;
      const file = relative(root, absolute).replaceAll('\\', '/');
      if (
        isAbsolute(file) ||
        file.startsWith('../') ||
        file.split('/').includes('node_modules')
      )
        continue;
      const parsed = stackFrameSchema.safeParse({
        file,
        line: Number(match[2]),
        column: Number(match[3]),
      });
      if (parsed.success) frames.push(parsed.data);
      if (frames.length === INCIDENT_LIMITS.stackFrames) break;
    }
    return frames;
  } catch {
    return [];
  }
}
