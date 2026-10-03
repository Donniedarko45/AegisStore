import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Fingerprint, HardDrive, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '../components/app/shell';
import { Button } from '../components/ui/button';
import { ErrorNote, Field, Input } from '../components/ui/primitives';
import { http, type UserDto } from '../lib/api';
import { useMe } from '../lib/queries';

const FEATURES = [
  { icon: HardDrive, title: 'Replicated by default', text: 'Every object lands on two nodes picked by a consistent-hash ring.' },
  { icon: Fingerprint, title: 'Verified end to end', text: 'SHA-256 checked on upload and on every download.' },
  { icon: ShieldCheck, title: 'Survives node failures', text: 'Reads fall back to a healthy replica automatically.' },
];

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isLogin = mode === 'login';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const me = useMe().data;
  if (me) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await http.post<{ user: UserDto }>(`/api/auth/${mode}`, isLogin ? { email, password } : { email, password, name: name.trim() || undefined });
      qc.setQueryData(['me'], res.user);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Logo /> AegisStore
        </Link>
        <div className="mx-auto flex w-full max-w-[360px] flex-1 flex-col justify-center py-12">
          <div className="stagger">
            <h1 className="text-[28px] font-semibold tracking-[-0.03em]">{isLogin ? 'Sign in' : 'Create your account'}</h1>
            <p className="mt-2 text-sm text-fg-2">{isLogin ? 'Welcome back. Your storage cluster is waiting.' : 'Start storing objects across replicated, verified nodes.'}</p>
            <form onSubmit={submit} className="mt-8 space-y-4">
              {!isLogin && <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Ada Lovelace" maxLength={100} />}</Field>}
              <Field label="Email">{(id) => <Input id={id} type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" className="h-10" />}</Field>
              <Field label="Password" hint={isLogin ? undefined : 'At least 8 characters.'}>
                {(id) => <Input id={id} type="password" required minLength={isLogin ? 1 : 8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={isLogin ? 'current-password' : 'new-password'} className="h-10" />}
              </Field>
              <ErrorNote error={error} />
              <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                {isLogin ? 'Continue' : 'Create account'} <ArrowRight />
              </Button>
            </form>
            <p className="mt-6 text-center text-[13px] text-fg-2">
              {isLogin ? "Don't have an account? " : 'Already have an account? '}
              <Link to={isLogin ? '/register' : '/login'} state={{ from }} className="font-medium text-fg underline-offset-4 hover:underline">
                {isLogin ? 'Sign up' : 'Sign in'}
              </Link>
            </p>
          </div>
        </div>
      </div>
      <aside className="relative hidden overflow-hidden border-l border-line bg-surface lg:flex lg:flex-col lg:justify-center lg:px-16">
        <div aria-hidden className="absolute inset-0 [background-image:radial-gradient(var(--border-2)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="relative max-w-md">
          <p className="text-sm font-medium text-fg-2">Distributed object storage</p>
          <h2 className="mt-3 text-[34px] leading-[1.1] font-semibold tracking-[-0.035em]">Your files on many machines. Never lost, never silently corrupted.</h2>
          <ul className="stagger mt-10 space-y-5">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface shadow-raised">
                  <f.icon className="size-4 text-fg-2" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{f.title}</span>
                  <span className="block text-[13px] text-fg-2">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
