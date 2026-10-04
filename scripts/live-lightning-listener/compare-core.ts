// Small, deterministic set comparison for a bounded research run.
export function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  let shared = 0;
  for (const key of left) if (right.has(key)) shared++;
  const leftOnly = left.size - shared;
  const rightOnly = right.size - shared;
  const union = shared + leftOnly + rightOnly;
  return { shared, leftOnly, rightOnly, union,
    overlapPctOfUnion: union ? 100 * shared / union : null,
    sharedPctOfLeft: left.size ? 100 * shared / left.size : null,
    sharedPctOfRight: right.size ? 100 * shared / right.size : null };
}
