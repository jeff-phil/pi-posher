import crypto from 'node:crypto';

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
