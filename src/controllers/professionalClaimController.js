import { randomUUID } from "node:crypto";
import { createToken } from "./authController.js";
import * as claims from "../services/professionalClaimService.js";

const handle = (work, status = 200) => async (req,res) => {
  try { return res.status(status).json({ success: true, data: await work(req) }); }
  catch (error) {
    if (!error.status) console.error(`[professional-claim:${randomUUID()}]`, error);
    return res.status(error.status || 500).json({ success: false, code: error.code || "PROFESSIONAL_CLAIM_FAILED",
      message: error.status ? error.message : "Professional claim request failed." });
  }
};
export const search = handle(req => claims.searchProfessionals(req.query));
export const publicDetail = handle(req => claims.getProfessional(req.params.type,req.params.id));
export const registerAccount = async (req,res) => {
  try {
    const result = await claims.registerClaimAccount(req.body);
    return res.status(201).json({ success: true, user: result.user, target: result.target, token: createToken(result.user) });
  } catch (error) {
    if (!error.status) console.error(`[professional-registration:${randomUUID()}]`, error);
    return res.status(error.status || 500).json({ success: false, code: error.code || "REGISTRATION_FAILED",
      message: error.status ? error.message : "Registration failed." });
  }
};
export const state = handle(req => claims.getClaimState(req.params.type,req.params.id,req.user.id));
export const mine = handle(req => claims.ownProfessionalClaims(req.user.id));
export const managed = handle(req => claims.managedProfessionals(req.user.id));
export const submit = handle(req => claims.submitProfessionalClaim(req.user,req.body),201);
export const uploadUrl = handle(req => claims.professionalEvidenceUpload(req.user.id,req.body));
export const getOverlay = handle(req => claims.getProfessionalOverlay(req.user.id,req.params.type,req.params.id));
export const updateOverlay = handle(req => claims.updateProfessionalOverlay(req.user.id,req.params.type,req.params.id,req.body));
export const queue = handle(req => claims.adminProfessionalClaims(req.query));
export const detail = handle(req => claims.adminProfessionalDetail(req.params.id));
export const targetStatus = handle(req => claims.adminProfessionalTargetStatus(req.params.type,req.params.id));
export const evidence = handle(req => claims.professionalEvidenceUrl(req.params.id));
export const approve = handle(req => claims.decideProfessionalClaim(req.params.id,"approve",req.user,req.body?.notes));
export const reject = handle(req => claims.decideProfessionalClaim(req.params.id,"reject",req.user,req.body?.notes,req.body?.publicReason));
export const dispute = handle(req => claims.decideProfessionalClaim(req.params.id,"dispute",req.user,req.body?.notes));
export const revoke = handle(req => claims.revokeProfessionalMembership(req.params.type,req.params.id,Number(req.params.userId),req.user,req.body?.notes));
