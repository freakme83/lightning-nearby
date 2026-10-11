# Guarded CG repeat activation

Implementation in progress on current merge-ready. No deployment or hosted migration is performed by this PR.

The implementation will preserve Profile B and the ordinary initial/non-CG path, and add bounded suppressed-activity CG evaluation plus persistent atomic admissions. Repeat overrides must fail closed on ambiguous identity, freshness, geography, storage or restart recovery.
