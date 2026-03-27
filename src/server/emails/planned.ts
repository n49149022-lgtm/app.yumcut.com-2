import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { prisma } from '@/server/db';
import { config } from '@/server/config';
import { getResendClient } from '@/server/emails/resend';

const EMAIL_KIND_WELCOME = 'welcome_v1';
const EMAIL_KIND_FOLLOW_UP_24H = 'follow_up_24h_v1';

const DEFAULT_EMAIL_LANGUAGE = 'en';
const EMAIL_TEMPLATE_ROOT = path.join(process.cwd(), 'email');
const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const MAX_ATTEMPTS = 8;
const DEFAULT_PROCESS_LIMIT = 50;
const DEFAULT_LOCK_STALE_MINUTES = 10;

type SendResult = {
  ok: boolean;
  id?: string;
  error?: string;
};

type ParsedEmailTemplate = {
  language: string;
  subjectTemplate: string;
  textTemplate: string;
};

export type ScheduleUserOnboardingEmailsInput = {
  userId: string;
  email?: string | null;
  name?: string | null;
  targetLanguage?: string | null;
};

export type ProcessPlannedEmailsOptions = {
  limit?: number;
  userId?: string;
  lockStaleMinutes?: number;
};

export type ProcessPlannedEmailsResult = {
  claimed: number;
  sent: number;
  rescheduled: number;
  failed: number;
  skipped: number;
};

function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return null;
  if (normalized.endsWith('@guest.yumcut')) return null;
  if (normalized.length > 320) return null;
  return normalized;
}

function parseLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;
  const [primary] = normalized.split('-', 1);
  if (!primary || !/^[a-z]{2,8}$/.test(primary)) return null;
  return primary;
}

function normalizeLanguage(value: unknown): string {
  return parseLanguage(value) ?? DEFAULT_EMAIL_LANGUAGE;
}

function defaultGreetingName(language: string): string {
  return language === 'ru' ? 'друг' : 'there';
}

function pickGreetingName(name: string | null | undefined, language: string): string {
  const fallback = defaultGreetingName(language);
  if (!name) return fallback;
  const first = name.trim().split(/\s+/)[0] || '';
  const cleaned = first.replace(/[^\p{L}\p{N}'_-]/gu, '').trim();
  return cleaned || fallback;
}

function fillTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, key: string) => {
    const value = variables[key];
    return typeof value === 'string' ? value : '';
  });
}

async function loadTemplateMarkdown(language: string, kind: string): Promise<string | null> {
  const filePath = path.join(EMAIL_TEMPLATE_ROOT, language, `${kind}.md`);
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function parseMarkdownTemplate(markdown: string, kind: string, language: string): ParsedEmailTemplate {
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n');
  const lines = normalizedMarkdown.split('\n');
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);

  if (headerIndex < 0) {
    throw new Error(`Email template is empty: kind=${kind}, language=${language}`);
  }

  const headerLine = lines[headerIndex].trim();
  const headerMatch = headerLine.match(/^#{1,6}\s+(.+)$/);
  if (!headerMatch) {
    throw new Error(`Email template must start with a markdown heading: kind=${kind}, language=${language}`);
  }

  const subjectTemplate = headerMatch[1].trim();
  if (!subjectTemplate) {
    throw new Error(`Email template subject is empty: kind=${kind}, language=${language}`);
  }

  const bodyLines = lines.slice(headerIndex + 1);
  while (bodyLines.length > 0 && bodyLines[0].trim().length === 0) bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim().length === 0) bodyLines.pop();

  const textTemplate = bodyLines.join('\n').trim();
  if (!textTemplate) {
    throw new Error(`Email template body is empty: kind=${kind}, language=${language}`);
  }

  return {
    language,
    subjectTemplate,
    textTemplate,
  };
}

async function loadLocalizedTemplate(kind: string, languageHint: string): Promise<ParsedEmailTemplate> {
  const preferredLanguage = normalizeLanguage(languageHint);

  const preferredMarkdown = await loadTemplateMarkdown(preferredLanguage, kind);
  if (preferredMarkdown) {
    return parseMarkdownTemplate(preferredMarkdown, kind, preferredLanguage);
  }

  if (preferredLanguage !== DEFAULT_EMAIL_LANGUAGE) {
    const fallbackMarkdown = await loadTemplateMarkdown(DEFAULT_EMAIL_LANGUAGE, kind);
    if (fallbackMarkdown) {
      return parseMarkdownTemplate(fallbackMarkdown, kind, DEFAULT_EMAIL_LANGUAGE);
    }
  }

  throw new Error(`Email template not found for kind=${kind}. Checked languages: ${preferredLanguage}, ${DEFAULT_EMAIL_LANGUAGE}`);
}

function stringifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4000);
}

function computeRetryDelayMs(nextAttempt: number): number {
  const base = 15 * 60 * 1000;
  const exponential = base * Math.max(1, Math.pow(2, Math.max(0, nextAttempt - 1)));
  return Math.min(exponential, 24 * 60 * 60 * 1000);
}

async function resolveTargetLanguageForUser(userId: string, languageHint?: string | null): Promise<string> {
  const hinted = parseLanguage(languageHint);
  if (hinted) return hinted;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferredLanguage: true },
  });

  return normalizeLanguage(user?.preferredLanguage);
}

async function sendPlainTextEmail(params: { to: string; subject: string; text: string }): Promise<SendResult> {
  const from = config.RESEND_FROM_EMAIL?.trim();
  if (!from) {
    return {
      ok: false,
      error: 'RESEND_FROM_EMAIL is not configured.',
    };
  }

  try {
    const resend = getResendClient();
    const response = await resend.emails.send({
      from,
      to: [params.to],
      subject: params.subject,
      text: params.text,
    });

    const responseError = (response as any)?.error;
    if (responseError) {
      return {
        ok: false,
        error: typeof responseError?.message === 'string' ? responseError.message : JSON.stringify(responseError),
      };
    }

    return {
      ok: true,
      id: (response as any)?.data?.id,
    };
  } catch (error) {
    return {
      ok: false,
      error: stringifyError(error),
    };
  }
}

export async function queueUserOnboardingEmails(input: ScheduleUserOnboardingEmailsInput): Promise<boolean> {
  const email = normalizeEmail(input.email);
  if (!email) {
    return false;
  }

  const targetLanguage = await resolveTargetLanguageForUser(input.userId, input.targetLanguage);
  const now = new Date();
  const followUpAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await prisma.plannedEmail.createMany({
    data: [
      {
        userId: input.userId,
        email,
        kind: EMAIL_KIND_WELCOME,
        targetLanguage,
        scheduledAt: now,
      },
      {
        userId: input.userId,
        email,
        kind: EMAIL_KIND_FOLLOW_UP_24H,
        targetLanguage,
        scheduledAt: followUpAt,
      },
    ],
    skipDuplicates: true,
  });

  return true;
}

export async function processPlannedEmails(options: ProcessPlannedEmailsOptions = {}): Promise<ProcessPlannedEmailsResult> {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit as number)) : DEFAULT_PROCESS_LIMIT;
  const lockStaleMinutes = Number.isFinite(options.lockStaleMinutes)
    ? Math.max(1, Math.floor(options.lockStaleMinutes as number))
    : DEFAULT_LOCK_STALE_MINUTES;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - lockStaleMinutes * 60 * 1000);
  const lockId = crypto.randomUUID();

  const claimed = await prisma.$transaction(async (tx) => {
    const due = await tx.plannedEmail.findMany({
      where: {
        status: 'pending',
        scheduledAt: { lte: now },
        ...(options.userId ? { userId: options.userId } : {}),
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: [
        { scheduledAt: 'asc' },
        { createdAt: 'asc' },
      ],
      take: limit,
      select: { id: true },
    });

    if (due.length === 0) {
      return [] as Array<{
        id: string;
        email: string;
        kind: string;
        attempts: number;
        targetLanguage: string;
        user: { preferredLanguage: string; name: string | null } | null;
      }>;
    }

    const ids = due.map((item) => item.id);

    await tx.plannedEmail.updateMany({
      where: {
        id: { in: ids },
        status: 'pending',
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: staleBefore } },
        ],
      },
      data: {
        lockId,
        lockedAt: now,
      },
    });

    return tx.plannedEmail.findMany({
      where: { lockId, status: 'pending' },
      select: {
        id: true,
        email: true,
        kind: true,
        attempts: true,
        targetLanguage: true,
        user: {
          select: {
            preferredLanguage: true,
            name: true,
          },
        },
      },
      orderBy: [
        { scheduledAt: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  });

  const result: ProcessPlannedEmailsResult = {
    claimed: claimed.length,
    sent: 0,
    rescheduled: 0,
    failed: 0,
    skipped: 0,
  };

  for (const planned of claimed) {
    const languageHint = parseLanguage(planned.user?.preferredLanguage)
      ?? parseLanguage(planned.targetLanguage)
      ?? DEFAULT_EMAIL_LANGUAGE;

    let resolvedLanguage = normalizeLanguage(languageHint);
    let sendResult: SendResult;

    try {
      const template = await loadLocalizedTemplate(planned.kind, languageHint);
      resolvedLanguage = template.language;
      const greetingName = pickGreetingName(planned.user?.name, resolvedLanguage);
      const subject = fillTemplate(template.subjectTemplate, { name: greetingName });
      const text = fillTemplate(template.textTemplate, { name: greetingName });
      sendResult = await sendPlainTextEmail({
        to: planned.email,
        subject,
        text,
      });
    } catch (error) {
      sendResult = {
        ok: false,
        error: stringifyError(error),
      };
    }

    if (sendResult.ok) {
      const updated = await prisma.plannedEmail.updateMany({
        where: { id: planned.id, lockId, status: 'pending' },
        data: {
          status: 'sent',
          targetLanguage: resolvedLanguage,
          sentAt: new Date(),
          lastError: null,
          lockId: null,
          lockedAt: null,
          attempts: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        result.skipped += 1;
      } else {
        result.sent += 1;
      }
      continue;
    }

    const nextAttempt = planned.attempts + 1;
    const terminalFailure = nextAttempt >= MAX_ATTEMPTS;
    const nextSchedule = new Date(Date.now() + computeRetryDelayMs(nextAttempt));

    const updated = await prisma.plannedEmail.updateMany({
      where: { id: planned.id, lockId, status: 'pending' },
      data: {
        status: terminalFailure ? 'failed' : 'pending',
        targetLanguage: resolvedLanguage,
        scheduledAt: terminalFailure ? now : nextSchedule,
        lastError: (sendResult.error || 'Unknown email send error').slice(0, 4000),
        lockId: null,
        lockedAt: null,
        attempts: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      result.skipped += 1;
      continue;
    }

    if (terminalFailure) {
      result.failed += 1;
    } else {
      result.rescheduled += 1;
    }
  }

  return result;
}

export async function scheduleUserOnboardingEmails(input: ScheduleUserOnboardingEmailsInput): Promise<{ queued: boolean; processed: ProcessPlannedEmailsResult | null }> {
  const queued = await queueUserOnboardingEmails(input);
  if (!queued) {
    return { queued: false, processed: null };
  }

  const processed = await processPlannedEmails({
    limit: 10,
    userId: input.userId,
  });

  return { queued: true, processed };
}
