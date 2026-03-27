import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, error } from '@/server/http';
import { withApiError } from '@/server/errors';
import { processPlannedEmails } from '@/server/emails/planned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  lockStaleMinutes: z.number().int().min(1).max(120).optional(),
});

function parseLimit(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.floor(parsed);
  if (rounded < 1 || rounded > 500) return undefined;
  return rounded;
}

function parseLockStaleMinutes(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.floor(parsed);
  if (rounded < 1 || rounded > 120) return undefined;
  return rounded;
}

export const GET = withApiError(async function GET(req: NextRequest) {
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'));
  const lockStaleMinutes = parseLockStaleMinutes(req.nextUrl.searchParams.get('lockStaleMinutes'));

  const result = await processPlannedEmails({
    limit,
    lockStaleMinutes,
  });

  return ok({ ok: true, ...result });
}, 'Failed to process planned emails');

export const POST = withApiError(async function POST(req: NextRequest) {
  const bodyRaw = await req.json().catch(() => ({}));
  const body = BodySchema.safeParse(bodyRaw);
  if (!body.success) {
    return error('VALIDATION_ERROR', 'Invalid payload', 400, body.error.flatten());
  }

  const result = await processPlannedEmails({
    limit: body.data.limit,
    lockStaleMinutes: body.data.lockStaleMinutes,
  });

  return ok({ ok: true, ...result });
}, 'Failed to process planned emails');
