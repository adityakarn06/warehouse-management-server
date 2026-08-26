import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(HttpError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
