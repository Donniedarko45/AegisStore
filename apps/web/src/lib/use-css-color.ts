import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

/** Canvas charts (Liveline) cannot read CSS variables; resolve them per theme. */
export function useCssColors<T extends string>(names: readonly T[]): Record<T, string> {
  const { resolvedTheme } = useTheme();
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim() || '#888'])) as Record<T, string>;
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    // wait a frame so the new data-theme attribute has applied
    const id = requestAnimationFrame(() => setColors(read()));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme, names.join()]);
  return colors;
}
