import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  plannedEmail: {
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const resendSendMock = vi.hoisted(() => vi.fn());

vi.mock('@/server/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/server/config', () => ({
  config: {
    RESEND_FROM_EMAIL: 'YumCut <hello@app.yumcut.com>',
  },
}));

vi.mock('@/server/emails/resend', () => ({
  getResendClient: () => ({
    emails: {
      send: resendSendMock,
    },
  }),
}));

import { queueUserOnboardingEmails, processPlannedEmails } from '@/server/emails/planned';

function mockClaimedEmails(claimed: Array<{
  id: string;
  email: string;
  kind: string;
  attempts: number;
  targetLanguage: string;
  user: { preferredLanguage: string; name: string | null } | null;
}>) {
  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    const tx = {
      plannedEmail: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce(claimed.map((item) => ({ id: item.id })))
          .mockResolvedValueOnce(claimed),
        updateMany: vi.fn().mockResolvedValue({ count: claimed.length }),
      },
    };
    return callback(tx);
  });
}

describe('planned emails localization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ preferredLanguage: 'en' });
    prismaMock.plannedEmail.createMany.mockResolvedValue({ count: 2 });
    prismaMock.plannedEmail.updateMany.mockResolvedValue({ count: 1 });
    resendSendMock.mockResolvedValue({ data: { id: 're_test_1' } });
  });

  it('stores targetLanguage when queueing onboarding emails', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ preferredLanguage: 'ru-RU' });

    const queued = await queueUserOnboardingEmails({
      userId: 'user-1',
      email: 'user@example.com',
      name: 'Ivan',
    });

    expect(queued).toBe(true);
    expect(prismaMock.plannedEmail.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ kind: 'welcome_v1', targetLanguage: 'ru' }),
          expect.objectContaining({ kind: 'follow_up_24h_v1', targetLanguage: 'ru' }),
        ]),
      }),
    );
  });

  it('uses russian template when user language is ru before send', async () => {
    mockClaimedEmails([
      {
        id: 'planned-1',
        email: 'user@example.com',
        kind: 'welcome_v1',
        attempts: 0,
        targetLanguage: 'en',
        user: { preferredLanguage: 'ru', name: 'Иван' },
      },
    ]);

    const result = await processPlannedEmails({ limit: 10 });

    expect(result).toEqual({
      claimed: 1,
      sent: 1,
      rescheduled: 0,
      failed: 0,
      skipped: 0,
    });

    expect(resendSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Добро пожаловать в YumCut',
        text: expect.stringContaining('Привет, Иван!'),
      }),
    );

    expect(prismaMock.plannedEmail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'sent',
          targetLanguage: 'ru',
        }),
      }),
    );
  });

  it('falls back to english template when language template is missing', async () => {
    mockClaimedEmails([
      {
        id: 'planned-2',
        email: 'user@example.com',
        kind: 'welcome_v1',
        attempts: 0,
        targetLanguage: 'de',
        user: { preferredLanguage: 'de-DE', name: 'Max' },
      },
    ]);

    await processPlannedEmails({ limit: 10 });

    expect(resendSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Welcome to YumCut',
        text: expect.stringContaining('Hey Max,'),
      }),
    );

    expect(prismaMock.plannedEmail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'sent',
          targetLanguage: 'en',
        }),
      }),
    );
  });
});
