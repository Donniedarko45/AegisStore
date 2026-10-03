import { Tooltip } from '@base-ui/react/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { App } from './App';
import { ApiError } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: true,
      // never hammer the API on client errors (401/403/404/422)
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
    },
  },
});

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={(resolvedTheme as 'light' | 'dark') ?? 'system'}
      position="top-center"
      closeButton
      toastOptions={{ classNames: { toast: 'font-sans !rounded-xl !shadow-popover', description: '!text-fg-2' } }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        {/* tooltips share a group: after the first, neighbours open instantly (no delay, no animation) */}
        <Tooltip.Provider delay={400} closeDelay={0} timeout={400}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </Tooltip.Provider>
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
