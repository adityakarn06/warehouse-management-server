import cors from 'cors';
import express, { type Express } from 'express';
import { apiV1Router } from './routes/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { getHealth } from './controllers/health.controller.js';
import { env } from './config/index.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Ahead of the body parsers: a malformed or oversized body fails inside
  // `express.json()` and would otherwise skip straight to `errorHandler`,
  // leaving the 400 (and every CORS preflight) out of the request log.
  app.use(requestLogger);
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', getHealth);

  app.use('/api/v1', apiV1Router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
