#!/usr/bin/env node
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });

type CliArgs = {
  limit?: number;
  lockStaleMinutes?: number;
};

function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {};
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (Number.isFinite(value) && value >= 1 && value <= 500) {
        parsed.limit = Math.floor(value);
      }
    }
    if (arg.startsWith('--lock-stale-minutes=')) {
      const value = Number(arg.slice('--lock-stale-minutes='.length));
      if (Number.isFinite(value) && value >= 1 && value <= 120) {
        parsed.lockStaleMinutes = Math.floor(value);
      }
    }
  }
  return parsed;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const [{ processPlannedEmails }, { prisma }] = await Promise.all([
    import('../src/server/emails/planned'),
    import('../src/server/db'),
  ]);

  try {
    const result = await processPlannedEmails(options);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Failed to send planned emails:', error);
  process.exit(1);
});
