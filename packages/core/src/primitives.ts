import { z } from 'zod';
import { INCIDENT_LIMITS } from './limits.js';

// IDs are safe for correlation fields; labels and summaries still need SDK sanitization.
export const identifierSchema = z
  .string()
  .min(1)
  .max(INCIDENT_LIMITS.identifierLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const labelSchema = z.string().trim().min(1).max(INCIDENT_LIMITS.labelLength);
export const summarySchema = z.string().trim().min(1).max(INCIDENT_LIMITS.summaryLength);
export const offsetSchema = z.number().int().min(0).max(INCIDENT_LIMITS.durationMs);
export const timestampSchema = z.iso.datetime({ precision: 3 });

export const httpMethodSchema = z.enum([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);

// Route templates only: raw URLs, query strings, credentials and fragments are excluded.
export const routeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\/[A-Za-z0-9/_.:{}*~-]*$/);
