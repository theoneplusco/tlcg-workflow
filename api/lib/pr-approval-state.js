// api/lib/pr-approval-state.js — P2P approval state computation
// Pure function — mirrors computePRApprovalState_ from TLCG_P2P_BACKEND.gs.
// This is the single source of truth for active stage (server-side).

/**
 * @param {object} pr — purchase_requests row (camelCased or snake_case)
 * @param {object} metadata — parsed metadata JSONB
 * @returns {{ stage, statusLabel, budgetEmail, supplierEmail, contractEmail, purchasingEmail, parallelComplete, contractDone }}
 */
export function computePRApprovalState(pr, metadata) {
  const budgetEmail     = (pr.budget_approver_email    || pr.budgetApproverEmail    || '').toLowerCase().trim();
  const supplierEmail   = (pr.supplier_approver_email  || pr.supplierApproverEmail  || '').toLowerCase().trim();
  const contractEmail   = (pr.contract_approver_email  || pr.contractApproverEmail  || '').toLowerCase().trim();
  const purchasingEmail = (pr.purchasing_approver_email|| pr.purchasingApproverEmail|| '').toLowerCase().trim();

  const budgetDone    = !budgetEmail    || metadata.budgetStatus    === 'Approved';
  const supplierDone  = !supplierEmail  || metadata.supplierStatus  === 'Approved';
  const p2pBranch     = metadata.p2pBranch || pr.p2p_branch || pr.p2pBranch || 'full';
  // Full branch: contract approval is handled in the separate Contract module,
  // so the PR's own contract stage is skipped. Simplified branch never requires it.
  const skipPRContract = p2pBranch === 'full' || p2pBranch === 'simplified';
  const contractDone  = skipPRContract || !contractEmail || metadata.contractStatus === 'Approved';
  const purchasingDone = !purchasingEmail || metadata.purchasingStatus === 'Approved';

  const parallelComplete = budgetDone && supplierDone;

  if (!parallelComplete)
    return { stage: 'parallel',    statusLabel: 'Đang duyệt ngân sách & NCC (2/5)',
             budgetEmail, supplierEmail, contractEmail, purchasingEmail,
             parallelComplete, contractDone };

  if (!skipPRContract && contractEmail && !contractDone)
    return { stage: 'contract',   statusLabel: 'Thẩm định Hợp đồng (4/5)',
             budgetEmail, supplierEmail, contractEmail, purchasingEmail,
             parallelComplete, contractDone };

  if (purchasingEmail && !purchasingDone)
    return { stage: 'purchasing', statusLabel: 'Mua hàng (5/5)',
             budgetEmail, supplierEmail, contractEmail, purchasingEmail,
             parallelComplete, contractDone };

  return { stage: 'complete',    statusLabel: 'Hoàn thành',
           budgetEmail, supplierEmail, contractEmail, purchasingEmail,
           parallelComplete, contractDone };
}

/**
 * Branch determination — mirrors computeP2PBranch_ from GAS.
 */
export function computeP2PBranch(purchaseType, grandTotal) {
  const pt = (purchaseType || 'goods').trim().toLowerCase();
  const gt = parseFloat(grandTotal) || 0;
  if (pt === 'services' || gt >= 2000000) return 'full';
  return 'simplified';
}
