/**
 * `pnpm db:seed` — the CLI wrapper.
 *
 * The demo world itself lives in `src/seed/seed-world.ts`, because
 * `POST /api/v1/simulation/reset` writes the same world at runtime and there
 * must be exactly one definition of t0. All this file owns is the standalone
 * Prisma client (the app's own client is not running here) and the exit code.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedWorld } from '../src/seed/seed-world.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

seedWorld(prisma)
  .then(({ baseTime, counts }) => {
    console.log(`\nSeed complete (base time ${baseTime.toISOString()})\n`);
    console.table(counts);
  })
  .catch((error: unknown) => {
    console.error('Seed failed', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
