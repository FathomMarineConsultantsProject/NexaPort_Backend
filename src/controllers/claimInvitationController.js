import { randomUUID } from "node:crypto";
import * as invitations from "../services/claimInvitationService.js";
const handle=(work,status=200)=>async(req,res)=>{try{return res.status(status).json({success:true,data:await work(req)});}catch(error){
  if(!error.status) console.error(`[claim-invitation:${randomUUID()}]`,error);
  return res.status(error.status||500).json({success:false,code:error.code||"INVITATION_FAILED",message:error.status?error.message:"Invitation request failed."});}};
export const issue=handle(req=>invitations.issueClaimInvitation(req.user,req.body),201);
export const revoke=handle(req=>invitations.revokeClaimInvitation(req.params.id,req.user));
export const list=handle(req=>invitations.listClaimInvitations(req.query));
export const preview=handle(req=>invitations.previewClaimInvitation(req.params.token));
export const redeem=handle(req=>invitations.redeemClaimInvitation(req.params.token,req.user));
