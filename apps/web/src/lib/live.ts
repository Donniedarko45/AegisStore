import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';

export interface LivePoint {
  time: number; // unix seconds (Liveline's unit)
  p50: number;
  p95: number;
  cpu: number;
  mem: number;
  probe: number;
}

interface LiveState {
  status: 'connecting' | 'live' | 'offline';
  lastBeat: Record<string, number>; // node name -> ms timestamp of last heartbeat
  series: Record<string, LivePoint[]>; // node name -> recent points
  beatSeq: number;
  setStatus: (s: LiveState['status']) => void;
  push: (node: string, p: LivePoint) => void;
}

const KEEP_SECONDS = 15 * 60;

export const useLive = create<LiveState>((set) => ({
  status: 'connecting',
  lastBeat: {},
  series: {},
  beatSeq: 0,
  setStatus: (status) => set({ status }),
  push: (node, p) =>
    set((s) => {
      const prev = s.series[node] ?? [];
      const cutoff = p.time - KEEP_SECONDS;
      const next = prev.length && prev[0]!.time < cutoff ? prev.filter((x) => x.time >= cutoff) : prev.slice();
      next.push(p);
      return { series: { ...s.series, [node]: next }, lastBeat: { ...s.lastBeat, [node]: Date.now() }, beatSeq: s.beatSeq + 1 };
    }),
}));

/**
 * Subscribes to the server's live event stream (SSE) while signed in. Heartbeats feed the live
 * charts; data events invalidate exactly the queries they affect, so pages update without polling.
 */
export function LiveConnection({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const { setStatus, push } = useLive.getState();
    setStatus('connecting');
    const es = new EventSource('/api/events/stream');
    const parse = (e: MessageEvent) => {
      try {
        return JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    es.addEventListener('ready', () => setStatus('live'));
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    es.addEventListener('node.metrics', (e) => {
      const d = parse(e as MessageEvent) as { name?: string; at?: string; metrics?: { latencyMsP50: number; latencyMsP95: number; cpuPct: number; memPct: number; probeMs?: number } };
      if (!d.name || !d.metrics) return;
      push(d.name, {
        time: (d.at ? Date.parse(d.at) : Date.now()) / 1000,
        p50: d.metrics.latencyMsP50,
        p95: d.metrics.latencyMsP95,
        cpu: d.metrics.cpuPct,
        mem: d.metrics.memPct,
        probe: d.metrics.probeMs ?? 0,
      });
    });
    es.addEventListener('node.status', () => {
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['uptime'] });
      void qc.invalidateQueries({ queryKey: ['ring'] });
    });
    const onObject = (e: Event) => {
      const d = parse(e as MessageEvent) as { bucket?: string };
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['analytics'] });
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      if (d.bucket) {
        void qc.invalidateQueries({ queryKey: ['objects', d.bucket] });
        void qc.invalidateQueries({ queryKey: ['bucket', d.bucket] });
        void qc.invalidateQueries({ queryKey: ['deleted', d.bucket] });
      }
    };
    es.addEventListener('object.created', onObject);
    es.addEventListener('object.deleted', onObject);
    es.addEventListener('bucket.created', onObject);
    es.addEventListener('replica.flagged', () => void qc.invalidateQueries({ queryKey: ['object'] }));
    return () => {
      es.close();
      setStatus('offline');
    };
  }, [enabled, qc]);
  return null;
}
