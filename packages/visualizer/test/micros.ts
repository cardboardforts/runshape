// Times in these tests' printed output, written as the viewer writes them (webview's
// replay-pace.ts, which these tests can't import): "742 µs", "3.1 ms", "1.20 s".
export function formatMicros(us: number): string {
  if (us < 999.5) return `${Math.round(us)} µs`;
  if (us < 999_500) return `${(us / 1000).toFixed(us < 9_950 ? 1 : 0)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}
