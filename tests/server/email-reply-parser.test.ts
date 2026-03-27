import { describe, expect, it } from 'vitest';
import { extractLatestEmailReply } from '@/server/emails/reply-parser';

describe('extractLatestEmailReply', () => {
  it('extracts latest reply from gmail quoted chain', () => {
    const input = [
      'wuzzup',
      '',
      'On Thu, Mar 26, 2026 at 11:10 AM User Token <usertoken.polygon@gmail.com> wrote:',
      '> huray',
      '> ',
      '> On Thu, Mar 26, 2026 at 11:03 AM User Token <usertoken.polygon@gmail.com> wrote:',
      '> > hello world',
    ].join('\n');

    expect(extractLatestEmailReply(input)).toBe('wuzzup');
  });

  it('handles wrapped gmail wrote headers', () => {
    const input = [
      'hi i have a queso question. how is it going',
      'On Thu, Mar 26, 2026 at 11:16 AM User Token <usertoken.polygon@gmail.com>',
      'wrote:',
      '',
      '> wuzzup',
    ].join('\n');

    expect(extractLatestEmailReply(input)).toBe('hi i have a queso question. how is it going');
  });

  it('handles outlook original message delimiters', () => {
    const input = [
      'Latest answer',
      '',
      '-----Original Message-----',
      'From: YumCut <hello@app.yumcut.com>',
      'Sent: Thursday, March 26, 2026 10:53 AM',
      'Subject: Welcome to YumCut',
    ].join('\n');

    expect(extractLatestEmailReply(input)).toBe('Latest answer');
  });

  it('returns empty when body is only a quoted thread', () => {
    const input = [
      'On Thu, Mar 26, 2026 at 11:10 AM User Token <usertoken.polygon@gmail.com> wrote:',
      '> hello',
    ].join('\n');

    expect(extractLatestEmailReply(input)).toBe('');
  });
});
