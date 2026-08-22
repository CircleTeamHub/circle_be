import { createHash } from 'crypto';
import type { SessionContext } from './refresh-token.service';

function browserName(userAgent: string): string {
  if (/Edg\//i.test(userAgent)) return 'Microsoft Edge';
  if (/Firefox\//i.test(userAgent)) return 'Firefox';
  if (/CriOS\//i.test(userAgent)) return 'Chrome';
  if (/Chrome\//i.test(userAgent)) return 'Chrome';
  if (/Safari\//i.test(userAgent)) return 'Safari';
  return 'Unknown browser';
}

function operatingSystem(userAgent: string): string {
  if (/Android/i.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macOS';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return 'Unknown OS';
}

/** Persist only a coarse label; raw User-Agent and IP are unnecessary PII here. */
export function describeQrLoginDevice(context?: SessionContext): string {
  const userAgent = context?.userAgent?.trim();
  if (!userAgent) return 'Unknown browser · Unknown OS';
  return `${browserName(userAgent)} · ${operatingSystem(userAgent)}`;
}

/** Stable six-digit code shown on both browser and phone for visual comparison. */
export function qrLoginVerificationCode(qrToken: string): string {
  const digest = createHash('sha256').update(qrToken).digest();
  return digest.readUInt32BE(0).toString().slice(-6).padStart(6, '0');
}
