import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, File as FileIcon, RotateCw, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { ApiError, uploadObject } from '../../lib/api';
import { cx, formatBytes, plural } from '../../lib/format';
import { Spinner } from '../ui/spinner';
import { Tip } from '../ui/overlays';

export interface UploadItem {
  id: number;
  bucket: string;
  key: string;
  file: File;
  loaded: number;
  status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  error?: string;
  replicas?: string[];
  ctl?: AbortController;
}

const CONCURRENCY = 2;
let nextId = 1;

interface UploadState {
  items: UploadItem[];
  open: boolean;
  add: (bucket: string, prefix: string, files: File[]) => void;
  cancel: (id: number) => void;
  retry: (id: number) => void;
  clear: () => void;
  setOpen: (o: boolean) => void;
}

export const useUploads = create<UploadState>((set, get) => {
  const patch = (id: number, p: Partial<UploadItem>) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));

  const pump = () => {
    const { items } = get();
    const running = items.filter((i) => i.status === 'uploading').length;
    for (const it of items.filter((i) => i.status === 'queued').slice(0, Math.max(0, CONCURRENCY - running))) {
      const ctl = new AbortController();
      patch(it.id, { status: 'uploading', loaded: 0, ctl, error: undefined });
      uploadObject(it.bucket, it.key, it.file, (loaded) => patch(it.id, { loaded }), ctl.signal)
        .then((r) => {
          patch(it.id, { status: 'done', loaded: it.file.size, replicas: r.replicas.map((x) => x.node) });
          window.dispatchEvent(new CustomEvent('aegis:uploaded', { detail: { bucket: it.bucket } }));
        })
        .catch((e: unknown) => {
          const err = e instanceof ApiError ? e : null;
          patch(it.id, err?.code === 'ABORTED' ? { status: 'cancelled' } : { status: 'error', error: err?.message ?? 'Upload failed' });
        })
        .finally(pump);
    }
  };

  return {
    items: [],
    open: true,
    setOpen: (open) => set({ open }),
    add: (bucket, prefix, files) => {
      const clean = prefix.replace(/^\/+/, '');
      const p = clean && !clean.endsWith('/') ? `${clean}/` : clean;
      const fresh = files.map((file) => ({ id: nextId++, bucket, key: `${p}${(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name}`, file, loaded: 0, status: 'queued' as const }));
      set((s) => ({ items: [...s.items, ...fresh], open: true }));
      pump();
    },
    cancel: (id) => {
      const it = get().items.find((i) => i.id === id);
      if (it?.status === 'uploading') it.ctl?.abort();
      else if (it?.status === 'queued') patch(id, { status: 'cancelled' });
    },
    retry: (id) => {
      patch(id, { status: 'queued', error: undefined, loaded: 0 });
      pump();
    },
    clear: () => set((s) => ({ items: s.items.filter((i) => i.status === 'uploading' || i.status === 'queued') })),
  };
});

/**
 * Floating upload panel (bottom-right). Enters from below on first upload (spatial consistency)
 * and invalidates the bucket's queries as each file lands.
 */
export function UploadPanel() {
  const { items, open, setOpen, cancel, retry, clear } = useUploads();
  const qc = useQueryClient();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const onDone = (e: Event) => {
      const b = (e as CustomEvent<{ bucket: string }>).detail.bucket;
      void qc.invalidateQueries({ queryKey: ['objects', b] });
      void qc.invalidateQueries({ queryKey: ['bucket', b] });
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    };
    window.addEventListener('aegis:uploaded', onDone);
    return () => window.removeEventListener('aegis:uploaded', onDone);
  }, [qc]);

  const active = items.filter((i) => i.status === 'uploading' || i.status === 'queued');
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const totalBytes = items.reduce((a, i) => a + i.file.size, 0);
  const loadedBytes = items.reduce((a, i) => a + (i.status === 'done' ? i.file.size : i.loaded), 0);
  const pct = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0;

  // one summary toast when a batch finishes
  const [announced, setAnnounced] = useState(0);
  useEffect(() => {
    if (items.length && active.length === 0 && done + failed > announced) {
      setAnnounced(done + failed);
      if (failed) toast.error(`${plural(failed, 'upload', 'uploads')} failed`, { description: 'Retry from the uploads panel.' });
      else toast.success(`${plural(done, 'file', 'files')} uploaded`, { description: 'Each stored on 2 nodes with verified checksums.' });
    }
  }, [active.length, done, failed, items.length, announced]);

  useEffect(() => {
    if (items.length) requestAnimationFrame(() => setMounted(true));
    else setMounted(false);
  }, [items.length]);

  if (!items.length) return null;
  return (
    <section
      aria-label="Uploads"
      className={cx(
        'fixed right-4 bottom-4 z-30 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-xl bg-surface shadow-popover transition-[transform,opacity] duration-300 ease-out',
        mounted ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
      )}
    >
      <header className="flex items-center gap-3 px-4 py-3">
        {active.length ? <Spinner className="size-4 text-fg-2" /> : failed ? <XCircle className="size-4 text-bad" /> : <CheckCircle2 className="size-4 text-good" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{active.length ? `Uploading ${plural(active.length, 'file', 'files')}` : failed ? `${failed} failed, ${done} done` : `${plural(done, 'upload', 'uploads')} complete`}</p>
          <p className="text-xs text-fg-2 tabular-nums">
            {formatBytes(loadedBytes)} of {formatBytes(totalBytes)} · {pct}%
          </p>
        </div>
        <Tip content={open ? 'Collapse' : 'Expand'}>
          <button onClick={() => setOpen(!open)} className="pressable grid size-7 place-items-center rounded-md text-fg-2 hover:bg-surface-2" aria-label={open ? 'Collapse uploads' : 'Expand uploads'}>
            <ChevronDown className={cx('size-4 transition-transform duration-200 ease-out', !open && 'rotate-180')} />
          </button>
        </Tip>
        {!active.length && (
          <Tip content="Dismiss">
            <button onClick={clear} className="pressable grid size-7 place-items-center rounded-md text-fg-2 hover:bg-surface-2" aria-label="Dismiss uploads">
              <X className="size-4" />
            </button>
          </Tip>
        )}
      </header>
      <div className="h-0.5 bg-surface-2">
        <div className="h-full origin-left bg-[var(--series-1)] transition-transform duration-300 ease-out" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      {open && (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {items.map((i) => {
            const p = i.file.size ? i.loaded / i.file.size : i.status === 'done' ? 1 : 0;
            return (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5">
                <FileIcon className="size-4 shrink-0 text-fg-3" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]" title={`${i.bucket}/${i.key}`}>
                    {i.key}
                  </p>
                  {i.status === 'uploading' && (
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full origin-left rounded-full bg-[var(--series-1)] transition-transform duration-200 ease-out" style={{ transform: `scaleX(${p})` }} />
                    </div>
                  )}
                  <p className={cx('mt-0.5 text-xs', i.status === 'error' ? 'text-bad-text' : 'text-fg-2')}>
                    {i.status === 'queued' && 'Waiting…'}
                    {i.status === 'uploading' && `${formatBytes(i.loaded)} of ${formatBytes(i.file.size)}`}
                    {i.status === 'done' && `Stored on ${i.replicas?.join(' + ')}`}
                    {i.status === 'error' && i.error}
                    {i.status === 'cancelled' && 'Cancelled'}
                  </p>
                </div>
                {(i.status === 'uploading' || i.status === 'queued') && (
                  <Tip content="Cancel">
                    <button onClick={() => cancel(i.id)} className="pressable grid size-7 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-2" aria-label={`Cancel ${i.key}`}>
                      <X className="size-3.5" />
                    </button>
                  </Tip>
                )}
                {(i.status === 'error' || i.status === 'cancelled') && (
                  <Tip content="Retry">
                    <button onClick={() => retry(i.id)} className="pressable grid size-7 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-2" aria-label={`Retry ${i.key}`}>
                      <RotateCw className="size-3.5" />
                    </button>
                  </Tip>
                )}
                {i.status === 'done' && <CheckCircle2 className="size-4 shrink-0 text-good" aria-label="Uploaded" />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
