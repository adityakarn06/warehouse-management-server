import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/index.js';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';
import type { ErrorResponse } from '../types/index.js';

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

  const status = error instanceof HttpError ? error.status : 500;
  const message =
    error instanceof HttpError
      ? error.message
      : env.isProduction
        ? 'Internal Server Error'
        : error instanceof Error
          ? error.message
          : 'Internal Server Error';

  if (status >= 500) {
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, error);
  }

  const body: ErrorResponse = { error: { message, status } };
  if (error instanceof HttpError && error.details !== undefined) {
    body.error.details = error.details;
  }

  res.status(status).json(body);
}
