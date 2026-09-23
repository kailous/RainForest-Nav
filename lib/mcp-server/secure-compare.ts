import { createHash, timingSafeEqual } from 'crypto';

// Hashes both inputs first so the comparison is fixed-length: different-length
// secrets cannot be distinguished, and timingSafeEqual never throws.
export function constantTimeEquals(left: unknown, right: unknown): boolean {
  const a = createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const b = createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}
