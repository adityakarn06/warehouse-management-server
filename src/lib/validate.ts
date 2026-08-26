import type { Request } from 'express';
import { ZodError, type ZodType } from 'zod';
import { HttpError } from './http-error.js';

function parse<T>(schema: ZodType<T>, input: unknown, what: string): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw HttpError.badRequest(`Invalid ${what}`, error.issues);
    }
    throw error;
  }
}

export function parseQuery<T>(schema: ZodType<T>, req: Request): T {
  return parse(schema, req.query, 'query parameters');
}

export function parseParams<T>(schema: ZodType<T>, req: Request): T {
  return parse(schema, req.params, 'route parameters');
}

/** `express.json()` is mounted in `createApp()`, so `req.body` is already parsed. */
export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  return parse(schema, req.body, 'request body');
}
