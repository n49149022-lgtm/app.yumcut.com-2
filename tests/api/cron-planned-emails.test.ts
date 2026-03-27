import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const processPlannedEmails = vi.hoisted(() => vi.fn());
const assertServiceAuth = vi.hoisted(() => vi.fn());

vi.mock('@/server/emails/planned', () => ({
  processPlannedEmails,
}));

vi.mock('@/server/auth', () => ({
  assertServiceAuth,
}));

const route = await import('@/app/api/cron/planned-emails/route');

describe('/api/cron/planned-emails auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processPlannedEmails.mockResolvedValue({
      claimed: 0,
      sent: 0,
      rescheduled: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it('rejects GET without valid service auth', async () => {
    assertServiceAuth.mockReturnValue(false);

    const req = new NextRequest('http://localhost/api/cron/planned-emails');
    const res = await route.GET(req);

    expect(res.status).toBe(403);
    expect(processPlannedEmails).not.toHaveBeenCalled();
  });

  it('processes GET with valid service auth', async () => {
    assertServiceAuth.mockReturnValue(true);

    const req = new NextRequest('http://localhost/api/cron/planned-emails?limit=15&lockStaleMinutes=7');
    const res = await route.GET(req);

    expect(res.status).toBe(200);
    expect(processPlannedEmails).toHaveBeenCalledWith({ limit: 15, lockStaleMinutes: 7 });
  });

  it('rejects POST without valid service auth', async () => {
    assertServiceAuth.mockReturnValue(false);

    const req = new NextRequest('http://localhost/api/cron/planned-emails', {
      method: 'POST',
      body: JSON.stringify({ limit: 10 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await route.POST(req);

    expect(res.status).toBe(403);
    expect(processPlannedEmails).not.toHaveBeenCalled();
  });

  it('processes POST with valid service auth', async () => {
    assertServiceAuth.mockReturnValue(true);

    const req = new NextRequest('http://localhost/api/cron/planned-emails', {
      method: 'POST',
      body: JSON.stringify({ limit: 5, lockStaleMinutes: 12 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await route.POST(req);

    expect(res.status).toBe(200);
    expect(processPlannedEmails).toHaveBeenCalledWith({ limit: 5, lockStaleMinutes: 12 });
  });
});
