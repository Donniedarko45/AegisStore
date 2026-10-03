// Applies the saved theme before first paint (no flash). External file so the CSP needs no
// 'unsafe-inline'. Shares its storage key with src/lib/theme.ts.
(function () {
  try {
    var t = localStorage.getItem('theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    var el = document.documentElement;
    el.setAttribute('data-theme', dark ? 'dark' : 'light');
    el.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {}
})();
