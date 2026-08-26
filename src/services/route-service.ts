import { HttpError } from '../lib/http-error.js';
import { prisma } from '../lib/prisma.js';

/**
 * The only endpoint that returns `Route.geometry` — the frontend fetches it once
 * to draw the polyline, rather than receiving it on every truck payload.
 */
export async function getRouteById(idOrCode: string) {
  const byId = await prisma.route.findUnique({ where: { id: idOrCode } });
  if (byId) return byId;

  const byCode = await prisma.route.findUnique({ where: { code: idOrCode } });
  if (byCode) return byCode;

  throw HttpError.notFound(`Route ${idOrCode} was not found`);
}
