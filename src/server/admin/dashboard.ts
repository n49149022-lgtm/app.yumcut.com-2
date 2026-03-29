import { prisma } from '@/server/db';
import { ProjectStatus } from '@/shared/constants/status';
import { MOSCOW_TIME_ZONE } from '@/lib/date';

const DAILY_NEW_USERS_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const GUEST_EMAIL_SUFFIX = '@guest.yumcut';
const DAILY_DAY_KEY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: MOSCOW_TIME_ZONE,
});
const DAILY_DAY_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: MOSCOW_TIME_ZONE,
});

function toMoscowDayKey(date: Date) {
  return DAILY_DAY_KEY_FORMATTER.format(date);
}

type AdminDashboardSnapshotOptions = {
  includeGuestUsers?: boolean;
};

export async function getAdminDashboardSnapshot(options?: AdminDashboardSnapshotOptions) {
  const includeGuestUsers = options?.includeGuestUsers === true;
  const userAnalyticsFilter = includeGuestUsers
    ? { deleted: false }
    : {
      deleted: false,
      email: { not: { endsWith: GUEST_EMAIL_SUFFIX } },
    };
  const p = prisma as any;
  const now = new Date();
  const dailyNewUserSlots = Array.from({ length: DAILY_NEW_USERS_WINDOW_DAYS }, (_, index) => {
    const daysAgo = DAILY_NEW_USERS_WINDOW_DAYS - 1 - index;
    const date = new Date(now.getTime() - daysAgo * DAY_MS);
    return {
      key: toMoscowDayKey(date),
      label: DAILY_DAY_LABEL_FORMATTER.format(date),
    };
  });
  const oldestDailyNewUsersDate = new Date(now.getTime() - (DAILY_NEW_USERS_WINDOW_DAYS + 1) * DAY_MS);
  const dailyNewUserSlotKeys = new Set(dailyNewUserSlots.map((slot) => slot.key));
  const [
    userCount,
    projectCount,
    pendingApprovals,
    errorCount,
    recentUsers,
    recentUserCreations,
    recentProjects,
    recentErrors,
    // Template system counts (public/private)
    templatesPublic,
    templatesPrivate,
    artStylesPublic,
    artStylesPrivate,
    voiceStylesPublic,
    voiceStylesPrivate,
    voicesPublic,
    voicesPrivate,
    musicPublic,
    musicPrivate,
    captionsPublic,
    captionsPrivate,
    overlaysPublic,
    overlaysPrivate,
  ] = await prisma.$transaction([
    prisma.user.count({ where: userAnalyticsFilter }),
    prisma.project.count({ where: { deleted: false } }),
    prisma.project.count({
      where: {
        deleted: false,
        status: {
          in: [
            ProjectStatus.ProcessScriptValidate,
            ProjectStatus.ProcessAudioValidate,
          ],
        },
      },
    }),
    prisma.project.count({ where: { deleted: false, status: ProjectStatus.Error } }),
    prisma.user.findMany({
      where: userAnalyticsFilter,
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, name: true, createdAt: true },
      take: 5,
    }),
    prisma.user.findMany({
      where: {
        createdAt: { gte: oldestDailyNewUsersDate },
        ...userAnalyticsFilter,
      },
      select: { createdAt: true },
    }),
    prisma.project.findMany({
      where: { deleted: false },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true } },
      },
      take: 5,
    }),
    prisma.project.findMany({
      where: { deleted: false, status: ProjectStatus.Error },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        statusLog: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        user: { select: { id: true, email: true, name: true } },
      },
      take: 5,
    }),
    // Template system counts
    p.template.count({ where: { isPublic: true } }),
    p.template.count({ where: { isPublic: false } }),
    p.templateArtStyle.count({ where: { isPublic: true } }),
    p.templateArtStyle.count({ where: { isPublic: false } }),
    p.templateVoiceStyle.count({ where: { isPublic: true } }),
    p.templateVoiceStyle.count({ where: { isPublic: false } }),
    p.templateVoice.count({ where: { isPublic: true } }),
    p.templateVoice.count({ where: { isPublic: false } }),
    p.templateMusic.count({ where: { isPublic: true } }),
    p.templateMusic.count({ where: { isPublic: false } }),
    p.templateCaptionsStyle.count({ where: { isPublic: true } }),
    p.templateCaptionsStyle.count({ where: { isPublic: false } }),
    p.templateOverlay.count({ where: { isPublic: true } }),
    p.templateOverlay.count({ where: { isPublic: false } }),
  ]);
  const dailyNewUsersMap = new Map<string, number>();
  for (const slot of dailyNewUserSlots) {
    dailyNewUsersMap.set(slot.key, 0);
  }
  for (const user of recentUserCreations) {
    const dayKey = toMoscowDayKey(user.createdAt);
    if (!dailyNewUserSlotKeys.has(dayKey)) {
      continue;
    }
    dailyNewUsersMap.set(dayKey, (dailyNewUsersMap.get(dayKey) ?? 0) + 1);
  }
  const dailyNewUsers = dailyNewUserSlots.map((slot) => ({
    date: slot.key,
    label: slot.label,
    count: dailyNewUsersMap.get(slot.key) ?? 0,
  }));

  return {
    counts: {
      users: userCount,
      projects: projectCount,
      pendingApprovals,
      errors: errorCount,
    },
    templateSystem: {
      templates: { public: templatesPublic, private: templatesPrivate },
      artStyles: { public: artStylesPublic, private: artStylesPrivate },
      voiceStyles: { public: voiceStylesPublic, private: voiceStylesPrivate },
      voices: { public: voicesPublic, private: voicesPrivate },
      music: { public: musicPublic, private: musicPrivate },
      captionsStyles: { public: captionsPublic, private: captionsPrivate },
      overlays: { public: overlaysPublic, private: overlaysPrivate },
    },
    dailyNewUsersWindowDays: DAILY_NEW_USERS_WINDOW_DAYS,
    dailyNewUsers,
    recentUsers: recentUsers.map((u: { id: string; email: string; name: string | null; createdAt: Date }) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
    })),
    recentProjects: recentProjects.map((p: { id: string; title: string; status: string; createdAt: Date; user: { id: string; email: string; name: string | null } }) => ({
      id: p.id,
      title: p.title,
      status: p.status as ProjectStatus,
      createdAt: p.createdAt.toISOString(),
      user: {
        id: p.user.id,
        email: p.user.email,
        name: p.user.name,
      },
    })),
    recentErrors: recentErrors.map((p: { id: string; title: string; updatedAt: Date; statusLog: Array<{ message?: string | null }>; user: { id: string; email: string; name: string | null } }) => ({
      id: p.id,
      title: p.title,
      updatedAt: p.updatedAt.toISOString(),
      message: p.statusLog[0]?.message || null,
      user: {
        id: p.user.id,
        email: p.user.email,
        name: p.user.name,
      },
    })),
  };
}
