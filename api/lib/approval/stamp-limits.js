// api/lib/approval/stamp-limits.js — the largest sample signature that can be stamped on an approval
// (shared by step-up.js and signature-store.js without an import cycle).
export const MAX_STAMP_BYTES = 768000; // 750 KB decoded
