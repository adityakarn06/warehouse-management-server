import type { Response } from 'express';
import type { ApiEnvelope, ApiListEnvelope, ListMeta } from '../types/api.js';

/**
 * Single place that owns the success envelope. Mirrors the `{ error: {...} }`
 * shape rendered by the central error handler.
 */
export function sendData<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { data };
  res.status(status).json(body);
}

export function sendList<T>(res: Response, items: T[], meta: ListMeta, status = 200): void {
  const body: ApiListEnvelope<T> = { data: items, meta };
  res.status(status).json(body);
}
