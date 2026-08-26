export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  status: HealthStatus;
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface DatabaseHealthResponse {
  status: HealthStatus;
  latencyMs: number | null;
  error?: string;
}

export interface ErrorResponse {
  error: {
    message: string;
    status: number;
    details?: unknown;
  };
}
