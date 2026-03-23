import type Stripe from 'stripe';
import { prisma } from '@/server/db';
import { config } from '@/server/config';
import { getStripeClient } from '@/server/stripe/client';
import { logStripeSubscriptionEvent } from '@/server/stripe/subscription-logger';
import { notifyAdminsOfSubscriptionCancellation } from '@/server/telegram';
import {
  getStripePriceIdForProductId,
  getSubscriptionConfig,
  getSubscriptionConfigByStripePriceId,
  SUBSCRIPTION_PRODUCTS_BY_PLAN_KEY,
} from '@/shared/constants/subscriptions';
import {
  getUserSubscriptionStatus,
  processServerSubscriptionPurchase,
  type PurchaseSource,
} from '@/server/subscriptions';
import type { SubscriptionStatusDTO } from '@/shared/types';

type StripePlanKey = 'weekly' | 'monthly';

type AppUserProfile = {
  id: string;
  email: string | null;
  name: string | null;
};

function normalizeId(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasConfigValue(value: string | null | undefined) {
  return normalizeId(value) !== null;
}

function readMetadataUserId(metadata: Stripe.Metadata | null | undefined) {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata.userId;
  if (typeof raw !== 'string') return null;
  return normalizeId(raw);
}

function extractPriceId(price: string | Stripe.Price | null | undefined) {
  if (!price) return null;
  if (typeof price === 'string') return normalizeId(price);
  return normalizeId(price.id);
}

function extractCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
) {
  if (!customer) return null;
  if (typeof customer === 'string') return normalizeId(customer);
  if ('deleted' in customer && customer.deleted) return null;
  return normalizeId(customer.id);
}

function toStripeEnvironment(livemode: boolean) {
  return livemode ? 'StripeLive' : 'StripeTest';
}

function coerceUnixSecondsToDate(value: number | null | undefined, fallback = new Date()) {
  if (value === null || value === undefined) return fallback;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function resolveAppBaseUrl() {
  const base = config.NEXTAUTH_URL?.trim();
  if (!base) {
    throw new Error('NEXTAUTH_URL must be configured for Stripe checkout.');
  }
  return new URL(base).origin;
}

function resolveAbsoluteAppUrl(pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = resolveAppBaseUrl();
  return new URL(pathOrUrl, base).toString();
}

function buildStripeSuccessUrl() {
  const successUrl = new URL(resolveAbsoluteAppUrl(config.STRIPE_BILLING_SUCCESS_PATH));
  if (!successUrl.searchParams.has('session_id')) {
    successUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  }
  return successUrl.toString();
}

function buildStripeCancelUrl() {
  return resolveAbsoluteAppUrl(config.STRIPE_BILLING_CANCEL_PATH);
}

function buildStripePortalReturnUrl() {
  return resolveAbsoluteAppUrl(config.STRIPE_BILLING_PORTAL_RETURN_PATH);
}

function getPlanConfigByKey(planKey: StripePlanKey) {
  return SUBSCRIPTION_PRODUCTS_BY_PLAN_KEY[planKey];
}

function requirePriceIdForPlan(planKey: StripePlanKey) {
  const plan = getPlanConfigByKey(planKey);
  const priceId = getStripePriceIdForProductId(plan.productId);
  if (!priceId) {
    throw new Error(`Stripe price ID for ${planKey} plan is not configured.`);
  }
  return {
    plan,
    priceId,
  };
}

async function findUserById(userId: string): Promise<AppUserProfile | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
}

function extractCustomerIdFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>).customerId;
  return typeof raw === 'string' ? normalizeId(raw) : null;
}

async function findCustomerIdFromPurchaseHistory(userId: string) {
  const rows = await prisma.subscriptionPurchase.findMany({
    where: {
      userId,
      originalTransactionId: {
        startsWith: 'sub_',
      },
    },
    orderBy: {
      purchaseDate: 'desc',
    },
    take: 25,
    select: {
      payload: true,
    },
  });

  for (const row of rows) {
    const customerId = extractCustomerIdFromPayload(row.payload);
    if (customerId) return customerId;
  }

  return null;
}

async function findLatestStripeSubscriptionId(userId: string) {
  const latest = await prisma.subscriptionPurchase.findFirst({
    where: {
      userId,
      originalTransactionId: {
        startsWith: 'sub_',
      },
    },
    orderBy: [{ expiresDate: 'desc' }, { purchaseDate: 'desc' }],
    select: {
      originalTransactionId: true,
    },
  });
  if (!latest) return null;
  return normalizeId(latest.originalTransactionId);
}

async function findCustomerIdFromLatestStripeSubscription(userId: string) {
  const stripe = getStripeClient();
  const subscriptionId = await findLatestStripeSubscriptionId(userId);
  if (!subscriptionId) return null;

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return extractCustomerId(subscription.customer);
  } catch (error) {
    logStripeSubscriptionEvent('portal_customer_lookup_failed', {
      userId,
      subscriptionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function getSubscriptionCurrentPeriodEndUnix(subscription: Stripe.Subscription) {
  const values = subscription.items.data
    .map((item) => (typeof item.current_period_end === 'number' ? item.current_period_end : null))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return Math.max(...values);
}

function mapStripeCancellationState(subscription: Stripe.Subscription) {
  const currentPeriodEnd = getSubscriptionCurrentPeriodEndUnix(subscription);
  const effectiveUnix =
    subscription.cancel_at ??
    (subscription.cancel_at_period_end ? currentPeriodEnd : null) ??
    null;
  return {
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    cancellationEffectiveAt:
      subscription.cancel_at_period_end && effectiveUnix !== null
        ? coerceUnixSecondsToDate(effectiveUnix).toISOString()
        : null,
  };
}

function isStripeSubscriptionActiveLike(status: Stripe.Subscription.Status) {
  return (
    status === 'active' ||
    status === 'trialing' ||
    status === 'past_due' ||
    status === 'unpaid' ||
    status === 'incomplete'
  );
}

function stripeSubscriptionSortTimestamp(subscription: Stripe.Subscription) {
  const currentPeriodEnd = getSubscriptionCurrentPeriodEndUnix(subscription);
  return (
    currentPeriodEnd ??
    subscription.cancel_at ??
    subscription.canceled_at ??
    subscription.created ??
    0
  );
}

function pickBestSubscriptionCandidate(
  subscriptions: Stripe.Subscription[],
  expectedProductId: string | null,
  expectedSubscriptionId: string | null,
) {
  if (subscriptions.length === 0) return null;
  const sorted = [...subscriptions].sort((left, right) => {
    const leftMatchesSubId = Boolean(expectedSubscriptionId && left.id === expectedSubscriptionId);
    const rightMatchesSubId = Boolean(expectedSubscriptionId && right.id === expectedSubscriptionId);
    if (leftMatchesSubId !== rightMatchesSubId) return leftMatchesSubId ? -1 : 1;

    const leftPlan = getPlanFromSubscription(left)?.plan;
    const rightPlan = getPlanFromSubscription(right)?.plan;
    const leftMatches = Boolean(expectedProductId && leftPlan?.productId === expectedProductId);
    const rightMatches = Boolean(expectedProductId && rightPlan?.productId === expectedProductId);
    if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;

    const leftActiveLike = isStripeSubscriptionActiveLike(left.status);
    const rightActiveLike = isStripeSubscriptionActiveLike(right.status);
    if (leftActiveLike !== rightActiveLike) return leftActiveLike ? -1 : 1;

    const leftTs = stripeSubscriptionSortTimestamp(left);
    const rightTs = stripeSubscriptionSortTimestamp(right);
    if (leftTs !== rightTs) return rightTs - leftTs;
    return (right.created ?? 0) - (left.created ?? 0);
  });
  return sorted[0] ?? null;
}

async function getStripeCancellationStatus(userId: string, expectedProductId: string | null) {
  const stripe = getStripeClient();
  const expectedSubscriptionId = await findLatestStripeSubscriptionId(userId);

  if (expectedSubscriptionId) {
    try {
      const direct = await stripe.subscriptions.retrieve(expectedSubscriptionId);
      const directPlan = getPlanFromSubscription(direct)?.plan;
      const planMatches = !expectedProductId || directPlan?.productId === expectedProductId;
      if (planMatches) {
        return mapStripeCancellationState(direct);
      }
    } catch (error) {
      logStripeSubscriptionEvent('cancellation_status_direct_lookup_failed', {
        userId,
        subscriptionId: expectedSubscriptionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const customerId =
    (await findCustomerIdFromPurchaseHistory(userId)) ??
    (await findCustomerIdFromLatestStripeSubscription(userId));

  if (customerId) {
    try {
      const listed = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 20,
      });
      const candidate = pickBestSubscriptionCandidate(listed.data, expectedProductId, expectedSubscriptionId);
      if (candidate) return mapStripeCancellationState(candidate);
    } catch (error) {
      logStripeSubscriptionEvent('cancellation_status_list_failed', {
        userId,
        customerId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const subscriptionId = expectedSubscriptionId;
  if (!subscriptionId) {
    return {
      cancelAtPeriodEnd: false,
      cancellationEffectiveAt: null as string | null,
    };
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return mapStripeCancellationState(subscription);
  } catch (error) {
    logStripeSubscriptionEvent('cancellation_status_lookup_failed', {
      userId,
      subscriptionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      cancelAtPeriodEnd: false,
      cancellationEffectiveAt: null as string | null,
    };
  }
}

async function resolveUserIdFromStripeCustomer(customerId: string | null) {
  if (!customerId) return null;
  const stripe = getStripeClient();
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if ('deleted' in customer && customer.deleted) return null;
    return readMetadataUserId(customer.metadata);
  } catch (error) {
    logStripeSubscriptionEvent('customer_user_lookup_failed', {
      customerId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveUserFromStripeSubscription(
  subscription: Stripe.Subscription,
  fallbackUserId?: string | null,
): Promise<AppUserProfile | null> {
  const metadataUserId = readMetadataUserId(subscription.metadata);
  if (metadataUserId) {
    return findUserById(metadataUserId);
  }

  const normalizedFallback = normalizeId(fallbackUserId);
  if (normalizedFallback) {
    const fallbackUser = await findUserById(normalizedFallback);
    if (fallbackUser) return fallbackUser;
  }

  const knownOwner = await prisma.subscriptionPurchase.findFirst({
    where: {
      originalTransactionId: subscription.id,
    },
    orderBy: {
      purchaseDate: 'desc',
    },
    select: {
      userId: true,
    },
  });
  if (knownOwner?.userId) {
    const owner = await findUserById(knownOwner.userId);
    if (owner) return owner;
  }

  const customerId = extractCustomerId(subscription.customer);
  const customerUserId = await resolveUserIdFromStripeCustomer(customerId);
  if (!customerUserId) return null;
  return findUserById(customerUserId);
}

function getPlanFromInvoice(invoice: Stripe.Invoice) {
  for (const line of invoice.lines.data) {
    const priceId = extractPriceId(line.pricing?.price_details?.price);
    const plan = getSubscriptionConfigByStripePriceId(priceId);
    if (!plan || !priceId) continue;

    return {
      plan,
      priceId,
      line,
    };
  }

  const productIdFromSnapshot = normalizeId(invoice.parent?.subscription_details?.metadata?.productId);
  const planFromSnapshot = getSubscriptionConfig(productIdFromSnapshot);
  if (planFromSnapshot) {
    return {
      plan: planFromSnapshot,
      priceId: getStripePriceIdForProductId(planFromSnapshot.productId),
      line: null,
    };
  }

  return null;
}

function getPlanFromSubscription(subscription: Stripe.Subscription) {
  for (const item of subscription.items.data) {
    const priceId = extractPriceId(item.price);
    const plan = getSubscriptionConfigByStripePriceId(priceId);
    if (!plan || !priceId) continue;
    return {
      plan,
      priceId,
    };
  }
  return null;
}

function shouldTreatAsRenewal(invoice: Stripe.Invoice): PurchaseSource {
  return invoice.billing_reason === 'subscription_cycle' ? 'auto_renew' : 'user_purchase';
}

function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice) {
  const parentSubscription = invoice.parent?.subscription_details?.subscription;
  if (typeof parentSubscription === 'string') {
    return normalizeId(parentSubscription);
  }
  if (parentSubscription && typeof parentSubscription === 'object') {
    return normalizeId(parentSubscription.id);
  }

  for (const line of invoice.lines.data) {
    if (typeof line.subscription === 'string') {
      return normalizeId(line.subscription);
    }
    if (line.subscription && typeof line.subscription === 'object') {
      return normalizeId(line.subscription.id);
    }
    const parentLineSubscription = line.parent?.subscription_item_details?.subscription;
    if (typeof parentLineSubscription === 'string') {
      return normalizeId(parentLineSubscription);
    }
  }

  return null;
}

async function processInvoicePaymentSucceeded(invoice: Stripe.Invoice, eventId: string) {
  const invoiceId = normalizeId(invoice.id);
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);

  if (!invoiceId || !subscriptionId) {
    logStripeSubscriptionEvent('invoice_skipped_missing_ids', {
      eventId,
      invoiceId,
      subscriptionId,
    });
    return;
  }

  if (invoice.status !== 'paid' || typeof invoice.amount_paid !== 'number' || invoice.amount_paid <= 0) {
    logStripeSubscriptionEvent('invoice_skipped_not_paid', {
      eventId,
      invoiceId,
      subscriptionId,
      status: invoice.status ?? null,
      amountPaid: invoice.amount_paid ?? null,
    });
    return;
  }

  const planSelection = getPlanFromInvoice(invoice);
  if (!planSelection) {
    logStripeSubscriptionEvent('invoice_skipped_unknown_price', {
      eventId,
      invoiceId,
      subscriptionId,
    });
    return;
  }

  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const fallbackUserId =
    readMetadataUserId(invoice.metadata) ||
    readMetadataUserId(subscription.metadata);
  const user = await resolveUserFromStripeSubscription(subscription, fallbackUserId);
  if (!user) {
    logStripeSubscriptionEvent('invoice_skipped_user_not_found', {
      eventId,
      invoiceId,
      subscriptionId,
      customerId: extractCustomerId(invoice.customer),
    });
    return;
  }

  const source = shouldTreatAsRenewal(invoice);
  const purchaseDate = coerceUnixSecondsToDate(
    invoice.status_transitions?.paid_at ?? invoice.created ?? undefined,
  );
  const expiresDate = coerceUnixSecondsToDate(
    planSelection.line?.period?.end ?? invoice.period_end ?? undefined,
    purchaseDate,
  );
  const customerId = extractCustomerId(invoice.customer);

  const result = await processServerSubscriptionPurchase({
    userId: user.id,
    productId: planSelection.plan.productId,
    transactionId: invoiceId,
    originalTransactionId: subscriptionId,
    purchaseDate,
    expiresDate,
    environment: toStripeEnvironment(invoice.livemode),
    source,
    payload: {
      source: 'stripe_invoice',
      eventId,
      invoiceId,
      invoiceNumber: invoice.number ?? null,
      customerId,
      subscriptionId,
      priceId: planSelection.priceId,
      billingReason: invoice.billing_reason ?? null,
      amountPaid: invoice.amount_paid ?? null,
      currency: invoice.currency ?? null,
      periodStart: planSelection.line?.period?.start ?? invoice.period_start ?? null,
      periodEnd: planSelection.line?.period?.end ?? invoice.period_end ?? null,
      livemode: invoice.livemode,
    },
  });

  logStripeSubscriptionEvent('invoice_processed', {
    eventId,
    invoiceId,
    subscriptionId,
    userId: user.id,
    productId: result.productId,
    tokensGranted: result.tokensGranted,
    balance: result.balance,
    alreadyProcessed: result.alreadyProcessed,
    source,
    expiresAt: result.expiresAt,
  });
}

async function notifyStripeCancellation(
  subscription: Stripe.Subscription,
  eventId: string,
  reason: string,
) {
  const user = await resolveUserFromStripeSubscription(subscription);
  if (!user) {
    logStripeSubscriptionEvent('cancellation_skipped_user_not_found', {
      eventId,
      subscriptionId: subscription.id,
      reason,
    });
    return;
  }

  const planSelection = getPlanFromSubscription(subscription);
  const fallbackProductId = normalizeId(subscription.metadata.productId) ?? 'unknown';
  const productId = planSelection?.plan.productId ?? fallbackProductId;
  const productConfig = getSubscriptionConfig(productId);

  await notifyAdminsOfSubscriptionCancellation({
    userId: user.id,
    userEmail: user.email,
    userName: user.name,
    productId,
    productLabel: productConfig?.label ?? productId,
    transactionId:
      typeof subscription.latest_invoice === 'string'
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id ?? null,
    originalTransactionId: subscription.id,
    environment: toStripeEnvironment(subscription.livemode),
    reason,
    autoRenewStatus: subscription.cancel_at_period_end ? 0 : 1,
  });

  logStripeSubscriptionEvent('cancellation_notified', {
    eventId,
    subscriptionId: subscription.id,
    userId: user.id,
    productId,
    reason,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
}

async function processSubscriptionDeleted(subscription: Stripe.Subscription, eventId: string) {
  await notifyStripeCancellation(subscription, eventId, 'deleted');
}

async function processSubscriptionUpdated(
  subscription: Stripe.Subscription,
  previousAttributes: Record<string, unknown> | undefined,
  eventId: string,
) {
  const hadPreviousFlag =
    previousAttributes &&
    Object.prototype.hasOwnProperty.call(previousAttributes, 'cancel_at_period_end');
  const wasCancelAtPeriodEnd = hadPreviousFlag
    ? Boolean((previousAttributes as { cancel_at_period_end?: unknown }).cancel_at_period_end)
    : null;
  const becameCancelAtPeriodEnd = subscription.cancel_at_period_end === true;

  if (!hadPreviousFlag || wasCancelAtPeriodEnd !== false || !becameCancelAtPeriodEnd) {
    return;
  }

  await notifyStripeCancellation(subscription, eventId, 'cancel_at_period_end');
}

export async function createStripeCheckoutSession(input: {
  userId: string;
  userEmail: string | null;
  planKey: StripePlanKey;
}) {
  const stripe = getStripeClient();
  const { plan, priceId } = requirePriceIdForPlan(input.planKey);
  const existingCustomerId = await findCustomerIdFromPurchaseHistory(input.userId);

  const basePayload: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    success_url: buildStripeSuccessUrl(),
    cancel_url: buildStripeCancelUrl(),
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: input.userId,
    metadata: {
      userId: input.userId,
      productId: plan.productId,
      planKey: plan.planKey,
    },
    subscription_data: {
      metadata: {
        userId: input.userId,
        productId: plan.productId,
        planKey: plan.planKey,
      },
    },
    allow_promotion_codes: true,
  };

  if (existingCustomerId) {
    basePayload.customer = existingCustomerId;
  } else if (input.userEmail) {
    basePayload.customer_email = input.userEmail;
  }

  const session = await stripe.checkout.sessions.create(basePayload);
  if (!session.url) {
    throw new Error('Stripe checkout session is missing redirect URL.');
  }

  logStripeSubscriptionEvent('checkout_created', {
    userId: input.userId,
    sessionId: session.id,
    planKey: input.planKey,
    productId: plan.productId,
    priceId,
    existingCustomerId: existingCustomerId ?? null,
  });

  return {
    url: session.url,
    sessionId: session.id,
  };
}

export async function createStripeBillingPortalSession(userId: string) {
  const stripe = getStripeClient();
  const customerId =
    (await findCustomerIdFromPurchaseHistory(userId)) ??
    (await findCustomerIdFromLatestStripeSubscription(userId));

  if (!customerId) {
    throw new Error('No Stripe customer found for this account.');
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: buildStripePortalReturnUrl(),
  });

  logStripeSubscriptionEvent('portal_created', {
    userId,
    customerId,
  });

  return {
    url: portal.url,
  };
}

export async function getWebSubscriptionStatus(userId: string): Promise<SubscriptionStatusDTO> {
  const baseStatus = await getUserSubscriptionStatus(userId);
  const plans = (['weekly', 'monthly'] as const).map((planKey) => {
    const plan = getPlanConfigByKey(planKey);
    return {
      planKey: plan.planKey,
      productId: plan.productId,
      label: plan.label,
      interval: plan.interval,
      priceUsd: plan.priceUsd,
      tokens: plan.tokens,
      configured: Boolean(getStripePriceIdForProductId(plan.productId)),
    };
  });

  const stripeReady =
    Boolean(
      hasConfigValue(config.STRIPE_SECRET_KEY) &&
        hasConfigValue(config.STRIPE_WEBHOOK_SECRET) &&
        hasConfigValue(config.NEXTAUTH_URL),
    ) && plans.every((plan) => plan.configured);
  const canManageBilling = stripeReady
    ? Boolean(
        (await findCustomerIdFromPurchaseHistory(userId)) ??
          (await findCustomerIdFromLatestStripeSubscription(userId)),
      )
    : false;
  const cancellationStatus = stripeReady
    ? await getStripeCancellationStatus(userId, baseStatus.productId)
    : { cancelAtPeriodEnd: false, cancellationEffectiveAt: null as string | null };
  const cancellationEffectiveAt =
    cancellationStatus.cancellationEffectiveAt ??
    (cancellationStatus.cancelAtPeriodEnd ? baseStatus.expiresAt : null);

  return {
    ...baseStatus,
    cancelAtPeriodEnd: cancellationStatus.cancelAtPeriodEnd,
    cancellationEffectiveAt,
    plans,
    stripeReady,
    canManageBilling,
  };
}

export async function handleStripeWebhook(input: {
  signature: string | null;
  rawBody: string;
}) {
  const webhookSecret = config.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    throw new Error('Stripe webhook secret is not configured.');
  }
  if (!input.signature) {
    throw new Error('Missing Stripe signature header.');
  }

  const stripe = getStripeClient();
  const event = stripe.webhooks.constructEvent(
    input.rawBody,
    input.signature,
    webhookSecret,
  );

  logStripeSubscriptionEvent('webhook_received', {
    eventId: event.id,
    type: event.type,
    livemode: event.livemode,
  });

  switch (event.type) {
    case 'invoice.payment_succeeded': {
      await processInvoicePaymentSucceeded(event.data.object as Stripe.Invoice, event.id);
      break;
    }
    case 'customer.subscription.deleted': {
      await processSubscriptionDeleted(event.data.object as Stripe.Subscription, event.id);
      break;
    }
    case 'customer.subscription.updated': {
      await processSubscriptionUpdated(
        event.data.object as Stripe.Subscription,
        (event.data as { previous_attributes?: Record<string, unknown> }).previous_attributes,
        event.id,
      );
      break;
    }
    default: {
      logStripeSubscriptionEvent('webhook_ignored', {
        eventId: event.id,
        type: event.type,
      });
    }
  }

  return { received: true };
}
