export function formatCopyableDisplayLabel(displayLabel: string | null | undefined): string {
  const heading = "## Copyable display label";
  if (!displayLabel) return `${heading}\n\nNo usable display label was produced.`;
  const longestBacktickRun = Math.max(0, ...Array.from(displayLabel.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${heading}\n\n${fence}text\n${displayLabel}\n${fence}`;
}
