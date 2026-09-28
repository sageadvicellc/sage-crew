import { describe, expect, it } from 'vitest';
import { resolveTransport } from '../src/transport.ts';

describe('transport', () => {
  it('27: auto maps each tier, and --transport file wins', () => {
    expect(resolveTransport('auto', 1, {})).toBe('native');
    expect(resolveTransport('auto', 2, {})).toBe('file-mailbox');
    expect(resolveTransport('auto', 2, { a2aConfigured: true })).toBe('a2a');
    expect(resolveTransport('auto', 3, {})).toBe('file-mailbox');
    expect(resolveTransport('native', 3, {})).toBe('native');
    for (const tier of [1, 2, 3] as const) {
      expect(resolveTransport('auto', tier, { flag: 'file-mailbox' })).toBe('file-mailbox');
      expect(resolveTransport('native', tier, { flag: 'file-mailbox' })).toBe('file-mailbox');
    }
  });
});
