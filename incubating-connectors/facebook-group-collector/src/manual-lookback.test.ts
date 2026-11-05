import { describe, expect, it } from 'vitest';
import { manualLookbackHours } from './manual-lookback.js';

describe('manual run lookback', () => {
  it('defaults omitted lookback to one hour', () => {
    expect(manualLookbackHours({})).toBe(1);
  });

  it.each([1, 168, 720] as const)('accepts %i hours', hours => {
    expect(manualLookbackHours({ lookbackHours: hours })).toBe(hours);
  });

  it.each([{ lookbackHours: 0 }, { lookbackHours: 24 }, { lookbackHours: '168' }, { lookbackHours: null }, { lookbackHours: 1, cutoffAt: '2026-01-01' }])('rejects unsupported manual options %j', value => {
    expect(() => manualLookbackHours(value)).toThrow('Manual runs support 1 hour, 7 days, or 30 days');
  });
});
