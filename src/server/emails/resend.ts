import { Resend, WebhookEventPayload } from 'resend';
import { config } from '@/server/config';

let resendClient: Resend | null = null;

export function getResendClient(): Resend {
  const apiKey = config.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured.');
  }
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

export function verifyResendWebhook(payload: string, headers: Headers): WebhookEventPayload | null {
  const webhookSecret = config.RESEND_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    return null;
  }

  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signature = headers.get('svix-signature');
  if (!id || !timestamp || !signature) {
    return null;
  }

  try {
    const resend = getResendClient();
    return resend.webhooks.verify({
      payload,
      headers: {
        id,
        timestamp,
        signature,
      },
      webhookSecret,
    });
  } catch {
    return null;
  }
}

export async function getReceivedEmail(emailId: string) {
  const resend = getResendClient();
  const response = await resend.emails.receiving.get(emailId);
  if (response.error || !response.data) {
    const message = response.error?.message || `Unable to fetch received email ${emailId}`;
    throw new Error(message);
  }
  return response.data;
}
