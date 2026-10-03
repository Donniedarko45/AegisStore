import { describe, expect, it } from 'vitest';
import { evaluate, type WindowStats } from './jobs/anomaly';

const cfg = { deleteBurstPerMin: 50, deleteSharePct: 30, overwriteBurstPerMin: 50, entropyShifts: 5, extensionChurn: 10, protectDays: 30 };
const quiet: WindowStats = { deletes60s: 0, deletes10m: 0, overwrites60s: 0, entropyShifts: 0, suspiciousKeys: 0, liveObjects: 500, lastMinuteOps: 2, baselineMean: 2, baselineStd: 1 };

describe('anomaly evaluation', () => {
  it('normal activity raises nothing', () => {
    expect(evaluate(quiet, cfg).severity).toBeNull();
  });

  it('a routine sync job overwriting files is only MEDIUM', () => {
    const r = evaluate({ ...quiet, overwrites60s: 80, lastMinuteOps: 80, baselineMean: 70, baselineStd: 10 }, cfg);
    expect(r.severity).toBe('MEDIUM');
    expect(r.kind).toBe('ANOMALY');
  });

  it('encrypting files in place is RANSOMWARE, and corroborating signals escalate it', () => {
    const one = evaluate({ ...quiet, entropyShifts: 8 }, cfg);
    expect(one.severity).toBe('HIGH');
    expect(one.kind).toBe('RANSOMWARE');
    const two = evaluate({ ...quiet, entropyShifts: 8, suspiciousKeys: 12 }, cfg);
    expect(two.severity).toBe('CRITICAL');
  });

  it('deleting a third of a small bucket is a MASS_DELETE even below the per-minute burst', () => {
    const r = evaluate({ ...quiet, deletes10m: 12, deletes60s: 12, liveObjects: 20 }, cfg);
    expect(r.kind).toBe('MASS_DELETE');
    expect(r.severity).toBe('HIGH');
  });

  it('a few deletes in a large bucket are fine', () => {
    expect(evaluate({ ...quiet, deletes10m: 12, deletes60s: 3, liveObjects: 1000 }, cfg).severity).toBeNull();
  });

  it('a sudden burst far above the actor baseline is a rate anomaly', () => {
    const r = evaluate({ ...quiet, lastMinuteOps: 45, baselineMean: 1, baselineStd: 1 }, cfg);
    expect(r.signals.some((s) => s.signal === 'RATE_ANOMALY')).toBe(true);
    expect(r.severity).toBe('MEDIUM');
  });
});
