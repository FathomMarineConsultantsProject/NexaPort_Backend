import { randomUUID } from "node:crypto";
import * as claims from "../services/companyClaimService.js";

const handle = (work, status = 200) => async (req, res) => {
  try { return res.status(status).json({ success: true, data: await work(req) }); }
  catch (error) {
    if (!error.status) console.error(`[company-claim:${randomUUID()}]`, error);
    return res.status(error.status || 500).json({ success: false, code: error.code || "CLAIM_REQUEST_FAILED", message: error.status ? error.message : "Company claim request failed." });
  }
};

export const search = handle(req => claims.searchCompanies(req.query));
export const publicDetail = handle(req => claims.getPublicCompany(req.params.id));
export const mine = handle(req => claims.ownClaims(req.user.id));
export const managed = handle(req => claims.listManagedCompanies(req.user.id));
export const submit = handle(req => claims.submitClaim(req.user, req.body), 201);
export const uploadUrl = handle(req => claims.createClaimEvidenceUpload(req.user.id, req.body));
export const queue = handle(req => claims.adminClaims(req.query));
export const detail = handle(req => claims.adminClaimDetail(req.params.id));
export const targetStatus = handle(req => claims.adminCompanyTargetStatus(req.params.entityId));
export const evidence = handle(req => claims.claimEvidenceUrl(req.params.id));
export const approve = handle(req => claims.decideClaim(req.params.id, "approve", req.user, req.body?.notes));
export const reject = handle(req => claims.decideClaim(req.params.id, "reject", req.user, req.body?.notes, undefined, req.body?.publicReason));
export const dispute = handle(req => claims.decideClaim(req.params.id, "dispute", req.user, req.body?.notes));
export const revoke = handle(req => claims.revokeCompanyMembership(req.params.entityId,Number(req.params.userId),req.user,req.body?.notes));
