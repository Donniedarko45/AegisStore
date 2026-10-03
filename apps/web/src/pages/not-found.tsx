import { Link } from 'react-router-dom';
import { buttonStyles } from '../components/ui/button';

export function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-sm text-fg-3">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">This page could not be found</h1>
      <p className="mt-2 text-sm text-fg-2">The link may be broken, or the bucket was deleted.</p>
      <Link to="/" className={buttonStyles({ variant: 'primary', className: 'mt-6' })}>
        Back to overview
      </Link>
    </div>
  );
}
