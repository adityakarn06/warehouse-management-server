import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/index.js';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';
import type { ErrorResponse } from '../types/index.js';

/**
 * Errors raised by Express' own middleware — notably `express.json()` on a
 * malformed or oversized body — follow the `http-errors` convention of carrying
 * their own `status`/`statusCode`. Honour it for client errors so a bad request
 * body is reported as a 400 rather than a 500. Anything 5xx (or unlabelled)
 * stays a 500 so we never downgrade a genuine server fault.
 */
function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof Error) {
    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
    const candidate = typeof status === 'number' ? status : statusCode;
    if (typeof candidate === 'number' && candidate >= 400 && candidate < 500) {
      return candidate;
    }
  }
  return 500;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = statusOf(error);
  const rawMessage = error instanceof Error ? error.message : null;
  // Client errors describe the caller's own request, so their message is safe to
  // return in production; only 5xx messages are hidden.
  const message =
    error instanceof HttpError
      ? error.message
      : status < 500
        ? (rawMessage ?? 'Bad Request')
        : env.isProduction
          ? 'Internal Server Error'
          : (rawMessage ?? 'Internal Server Error');

  if (status >= 500) {
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, error);
  }

  const body: ErrorResponse = { error: { message, status } };
  if (error instanceof HttpError && error.details !== undefined) {
    body.error.details = error.details;
  }

  res.status(status).json(body);
}
