import { describe, expect, it } from 'vitest';
import { nextRiskStatus, scoreRisk, slope, type RiskInputs } from './risk';

const calm: RiskInputs = {
  diskUsedPct: 20,
  diskFullEtaHours: null,
  latencyP95Ms: 4,
  probeMs: 2,
  errorRate: 0,
  heartbeatAgeSec: 2,
  heartbeatIntervalSec: 5,
  offlineAfterSec: 15,
  flapsLastHour: 0,
  corruptRatio: 0,
  integrityFailures24h: 0,
  cpuPct: 10,
  memPct: 40,
};

describe('risk score', () => {
  it('is zero for a calm node', () => {
    const r = scoreRisk(calm);
    expect(r.score).toBe(0);
    expect(r.top).toBeNull();
  });

  it('a single strong signal is enough for HIGH_RISK', () => {
    const r = scoreRisk({ ...calm, errorRate: 0.2 });
    expect(r.score).toBeGreaterThanOrEqual(0.7);
    expect(r.top).toBe('errors');
    expect(nextRiskStatus('HEALTHY', r.score)).toBe('HIGH_RISK');
  });

  it('moderate signals add up (noisy-OR)', () => {
    const one = scoreRisk({ ...calm, diskUsedPct: 86 }).score;
    const two = scoreRisk({ ...calm, diskUsedPct: 86, probeMs: 160 }).score;
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(1);
  });

  it('a disk filling within the hour is a strong signal even when mostly empty', () => {
    const r = scoreRisk({ ...calm, diskUsedPct: 40, diskFullEtaHours: 0.5 });
    expect(r.top).toBe('disk');
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });

  it('flapping (offline incidents / restarts) raises heartbeat risk', () => {
    expect(scoreRisk({ ...calm, flapsLastHour: 2 }).contributions.heartbeat).toBeGreaterThan(0.4);
  });
});

describe('status hysteresis', () => {
  it('enters WARNING at 0.4 but leaves only below 0.3', () => {
    expect(nextRiskStatus('HEALTHY', 0.39)).toBe('HEALTHY');
    expect(nextRiskStatus('HEALTHY', 0.4)).toBe('WARNING');
    expect(nextRiskStatus('WARNING', 0.35)).toBe('WARNING');
    expect(nextRiskStatus('WARNING', 0.29)).toBe('HEALTHY');
  });
  it('leaves HIGH_RISK only below 0.6', () => {
    expect(nextRiskStatus('HIGH_RISK', 0.65)).toBe('HIGH_RISK');
    expect(nextRiskStatus('HIGH_RISK', 0.5)).toBe('WARNING');
    expect(nextRiskStatus('HIGH_RISK', 0.1)).toBe('HEALTHY');
  });
  it('never touches OFFLINE or DRAINING', () => {
    expect(nextRiskStatus('OFFLINE', 0)).toBe('OFFLINE');
    expect(nextRiskStatus('DRAINING', 0.99)).toBe('DRAINING');
  });
});

describe('slope', () => {
  it('fits a line', () => {
    expect(slope([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }])).toBeCloseTo(2);
    expect(slope([{ x: 0, y: 1 }])).toBeNull();
  });
});
