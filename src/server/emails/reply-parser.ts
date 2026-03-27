const QUOTE_HEADER_LINE_PATTERNS: RegExp[] = [
  /^\s*>/,
  /^\s*On .+wrote:\s*$/i,
  /^\s*On .+$/i,
  /^\s*wrote:\s*$/i,
  /^\s*From:\s.+/i,
  /^\s*Sent:\s.+/i,
  /^\s*To:\s.+/i,
  /^\s*Subject:\s.+/i,
  /^\s*-----\s*Original Message\s*-----\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/i,
  /^\s*-----\s*Forwarded message\s*-----\s*$/i,
];

const INLINE_QUOTE_HEADER_PATTERN = /(^|\s)On [^\n]*(?:\n[^\n]*){0,2}\s*wrote:\s*/i;

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function hasMeaningfulText(lines: string[]) {
  return lines.some((line) => line.trim() !== '');
}

function isWrappedOnWroteHeader(lines: string[], index: number) {
  const current = lines[index]?.trim() ?? '';
  if (!/^On .+/i.test(current)) {
    return false;
  }

  for (let lookAhead = index + 1; lookAhead <= Math.min(index + 2, lines.length - 1); lookAhead += 1) {
    const candidate = lines[lookAhead]?.trim() ?? '';
    if (!candidate) {
      continue;
    }

    if (/wrote:\s*$/i.test(candidate)) {
      return true;
    }
  }

  return false;
}

function cutByInlineHeader(value: string) {
  const match = INLINE_QUOTE_HEADER_PATTERN.exec(value);
  if (!match) {
    return value;
  }

  const before = value.slice(0, match.index).trimEnd();
  return before || value;
}

function findQuotedStartIndex(lines: string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const isQuoteHeader =
      QUOTE_HEADER_LINE_PATTERNS.some((pattern) => pattern.test(line))
      || isWrappedOnWroteHeader(lines, index);
    if (!isQuoteHeader) {
      continue;
    }

    const before = lines.slice(0, index);
    if (hasMeaningfulText(before)) {
      return index;
    }
  }

  return -1;
}

function isQuoteHeaderLine(line: string) {
  return QUOTE_HEADER_LINE_PATTERNS.some((pattern) => pattern.test(line.trim()));
}

function cleanupTrailingNoise(lines: string[]) {
  const copy = [...lines];

  while (copy.length > 0 && (copy[copy.length - 1] ?? '').trim() === '') {
    copy.pop();
  }

  while (copy.length > 0 && (copy[copy.length - 1] ?? '').trim() === '>') {
    copy.pop();
  }

  return copy;
}

export function extractLatestEmailReply(rawBody: string): string {
  const normalized = normalizeLineEndings(rawBody || '').trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n');
  const quotedStartIndex = findQuotedStartIndex(lines);
  const head = quotedStartIndex >= 0 ? lines.slice(0, quotedStartIndex) : lines;
  const cleanedHead = cleanupTrailingNoise(head);
  const joinedHead = cleanedHead.join('\n').trim();

  if (!joinedHead) {
    const firstLine = lines.find((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('>')) {
        return false;
      }

      const isQuoteHeader = QUOTE_HEADER_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
      return !isQuoteHeader;
    });
    return cutByInlineHeader(firstLine?.trim() ?? '');
  }

  const onlyQuoteHeaders = cleanedHead.every((line) => {
    const trimmed = line.trim();
    return !trimmed || isQuoteHeaderLine(trimmed);
  });
  if (onlyQuoteHeaders) {
    return '';
  }

  return cutByInlineHeader(joinedHead).trim();
}
