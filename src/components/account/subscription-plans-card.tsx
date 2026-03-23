'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, CalendarClock, CreditCard, Loader2, RefreshCcw, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Api } from '@/lib/api-client';
import { useAppLanguage } from '@/components/providers/AppLanguageProvider';
import type { AppLanguageCode } from '@/shared/constants/app-language';
import type { SubscriptionStatusDTO } from '@/shared/types';
import { requestTokenRefresh } from '@/hooks/useTokenSummary';
import { formatDateTime } from '@/lib/date';

type SubscriptionCardCopy = {
  title: string;
  description: string;
  statusActive: string;
  statusInactive: string;
  expiresAt: string;
  currentPlan: string;
  planTokens: (tokens: number) => string;
  per: {
    week: string;
    month: string;
  };
  startPlan: string;
  currentPlanButton: string;
  manageBilling: string;
  refreshing: string;
  refresh: string;
  checkoutCreating: string;
  portalOpening: string;
  checkoutSuccess: string;
  checkoutCancelled: string;
  checkoutError: string;
  portalError: string;
  notConfigured: string;
  recurringHint: string;
};

const COPY: Record<AppLanguageCode, SubscriptionCardCopy> = {
  en: {
    title: 'Subscription plans',
    description: 'Choose a recurring plan to auto-credit tokens after each successful charge.',
    statusActive: 'Subscription active',
    statusInactive: 'No active subscription',
    expiresAt: 'Current period ends',
    currentPlan: 'Current plan',
    planTokens: (tokens) => `${tokens.toLocaleString()} tokens per charge`,
    per: {
      week: 'week',
      month: 'month',
    },
    startPlan: 'Choose plan',
    currentPlanButton: 'Current plan',
    manageBilling: 'Manage billing',
    refreshing: 'Refreshing…',
    refresh: 'Refresh',
    checkoutCreating: 'Opening checkout…',
    portalOpening: 'Opening billing portal…',
    checkoutSuccess: 'Payment completed. Tokens will be credited automatically after successful charge.',
    checkoutCancelled: 'Checkout cancelled.',
    checkoutError: 'Failed to start checkout.',
    portalError: 'Failed to open billing portal.',
    notConfigured: 'Stripe billing is not configured yet.',
    recurringHint:
      'Renewals are processed automatically. Every successful weekly charge grants 150 tokens, monthly charge grants 600 tokens.',
  },
  ru: {
    title: 'Планы подписки',
    description: 'Выберите регулярный план, чтобы токены начислялись автоматически после каждого успешного списания.',
    statusActive: 'Подписка активна',
    statusInactive: 'Активной подписки нет',
    expiresAt: 'Текущий период до',
    currentPlan: 'Текущий план',
    planTokens: (tokens) => `${tokens.toLocaleString()} токенов за списание`,
    per: {
      week: 'неделю',
      month: 'месяц',
    },
    startPlan: 'Выбрать план',
    currentPlanButton: 'Текущий план',
    manageBilling: 'Управление оплатой',
    refreshing: 'Обновляем…',
    refresh: 'Обновить',
    checkoutCreating: 'Открываем оплату…',
    portalOpening: 'Открываем billing portal…',
    checkoutSuccess: 'Оплата завершена. Токены начислятся автоматически после успешного списания.',
    checkoutCancelled: 'Оплата отменена.',
    checkoutError: 'Не удалось запустить оплату.',
    portalError: 'Не удалось открыть billing portal.',
    notConfigured: 'Stripe-подписки пока не настроены.',
    recurringHint:
      'Продление происходит автоматически. Каждое успешное недельное списание даёт 150 токенов, месячное — 600 токенов.',
  },
};

function formatPeriodDate(value: string | null, fallback: string) {
  if (!value) return fallback;
  try {
    return formatDateTime(value);
  } catch {
    return value;
  }
}

export function SubscriptionPlansCard({ initialStatus }: { initialStatus: SubscriptionStatusDTO }) {
  const { language } = useAppLanguage();
  const t = COPY[language];
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<SubscriptionStatusDTO>(initialStatus);
  const [refreshing, setRefreshing] = useState(false);
  const [checkoutPlan, setCheckoutPlan] = useState<'weekly' | 'monthly' | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  const activeProductId = status.active ? status.productId : null;
  const activePlan = useMemo(
    () => status.plans.find((plan) => plan.productId === activeProductId) ?? null,
    [status.plans, activeProductId],
  );

  const fetchStatus = useCallback(async () => {
    const nextStatus = await Api.getSubscriptionStatus();
    setStatus(nextStatus);
    requestTokenRefresh();
    return nextStatus;
  }, []);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchStatus();
    } catch (error) {
      void error;
    } finally {
      setRefreshing(false);
    }
  }, [fetchStatus]);

  const startCheckout = async (plan: 'weekly' | 'monthly') => {
    setCheckoutPlan(plan);
    try {
      const { url } = await Api.createSubscriptionCheckout(plan);
      window.location.href = url;
    } catch (error) {
      toast.error(t.checkoutError);
      void error;
    } finally {
      setCheckoutPlan(null);
    }
  };

  const openPortal = async () => {
    setOpeningPortal(true);
    try {
      const { url } = await Api.createSubscriptionPortal();
      window.location.href = url;
    } catch (error) {
      toast.error(t.portalError);
      void error;
    } finally {
      setOpeningPortal(false);
    }
  };

  useEffect(() => {
    const billingState = searchParams.get('billing');
    const hasSessionId = Boolean(searchParams.get('session_id'));
    if (!billingState && !hasSessionId) return;

    const shouldSyncAfterRedirect = billingState === 'success' || hasSessionId;
    if (billingState === 'success') {
      toast.success(t.checkoutSuccess);
    } else if (billingState === 'cancelled') {
      toast.info(t.checkoutCancelled);
    }

    let cancelled = false;
    if (shouldSyncAfterRedirect) {
      void (async () => {
        const attempts = 8;
        for (let index = 0; index < attempts; index += 1) {
          if (cancelled) return;
          try {
            const next = await fetchStatus();
            if (next.active) return;
          } catch (error) {
            void error;
          }
          if (index < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
      })();
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('billing');
    nextParams.delete('session_id');
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });

    return () => {
      cancelled = true;
    };
  }, [searchParams, pathname, router, t.checkoutSuccess, t.checkoutCancelled, fetchStatus]);

  return (
    <Card>
      <CardHeader>
        <div className="flex w-full items-start gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Repeat className="h-5 w-5" />
              <span>{t.title}</span>
            </CardTitle>
            <CardDescription>{t.description}</CardDescription>
          </div>
          <Button
            className="ml-auto shrink-0"
            variant="outline"
            size="icon"
            onClick={() => void refreshStatus()}
            disabled={refreshing}
            aria-label={refreshing ? t.refreshing : t.refresh}
            title={refreshing ? t.refreshing : t.refresh}
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900/40">
          <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
            {status.active ? <BadgeCheck className="h-4 w-4 text-emerald-600" /> : <CalendarClock className="h-4 w-4" />}
            {status.active ? t.statusActive : t.statusInactive}
          </div>
          {status.active ? (
            <div className="mt-2 space-y-1 text-gray-600 dark:text-gray-300">
              {activePlan ? (
                <p>
                  {t.currentPlan}: <span className="font-medium text-gray-900 dark:text-gray-100">{activePlan.label}</span>
                </p>
              ) : null}
              <p>
                {t.expiresAt}:{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {formatPeriodDate(status.expiresAt, '—')}
                </span>
              </p>
            </div>
          ) : null}
        </div>

        {!status.stripeReady ? (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-900/40 dark:bg-yellow-950/30 dark:text-yellow-100">
            {t.notConfigured}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {status.plans.map((plan) => {
              const isCurrent = status.active && plan.productId === activeProductId;
              const planPeriod = plan.interval === 'week' ? t.per.week : t.per.month;
              const isLoading = checkoutPlan === plan.planKey;
              return (
                <div
                  key={plan.planKey}
                  className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
                >
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    ${plan.priceUsd.toFixed(2)} / {planPeriod}
                  </p>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                    {t.planTokens(plan.tokens)}
                  </p>
                  <Button
                    className="mt-3 w-full"
                    variant={isCurrent ? 'outline' : 'default'}
                    disabled={isCurrent || isLoading || openingPortal || refreshing || !plan.configured}
                    onClick={() => void startCheckout(plan.planKey)}
                  >
                    {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
                    {isCurrent ? t.currentPlanButton : isLoading ? t.checkoutCreating : t.startPlan}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-xs text-gray-500 dark:text-gray-400">{t.recurringHint}</p>

        {status.canManageBilling ? (
          <Button variant="outline" onClick={() => void openPortal()} disabled={openingPortal || checkoutPlan !== null}>
            {openingPortal ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
            {openingPortal ? t.portalOpening : t.manageBilling}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
