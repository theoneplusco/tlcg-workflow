// api/lib/purchase-requests/respond.js — PR response helpers (pure).
export const LOGIN_MSG = 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.';
export const NO_ACCESS_MSG = 'Bạn không có quyền xem đề nghị này.';

/** GAS spread its data into the top level; some pages read result.data.x (B8): send both. */
export const ok = (res, message, fields = {}) => res.json({ success: true, message, ...fields, data: fields });
export const fail = (res, message, status = 200) => res.status(status).json({ success: false, message });

/** The signed-in user, or null after answering 401. PR actions never trust emails in the body (S1). */
export async function signedInCaller(req, res, who) {
  let caller = null;
  try { caller = await who(req); } catch (e) { console.error('[PR] caller check:', e.message); }
  if (!caller) fail(res, LOGIN_MSG, 401);
  return caller;
}

/** approverEmail / requesterEmail sent by the page may only repeat the signed-in user's own. */
export function claimProblem(caller, claimed) {
  const want = String(claimed || '').trim().toLowerCase();
  return want && want !== caller.email ? `Bạn đang đăng nhập bằng ${caller.email}, không thể thao tác thay ${want}.` : null;
}
