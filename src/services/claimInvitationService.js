import { createHash, randomBytes } from "node:crypto";
import { pool } from "../config/db.js";
import { getPublicCompany } from "./companyClaimService.js";
import { getProfessional } from "./professionalClaimService.js";
import { sendClaimInvitationEmail } from "./emailService.js";
import { writeAdminAudit } from "./adminAuditService.js";

const TOKEN=/^[0-9a-f]{64}$/;
const clean=value=>String(value??"").trim();
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const hash=token=>createHash("sha256").update(token).digest("hex");
const targetInfo=async(type,id,db)=>{
  if(type==="company") {
    const company=await getPublicCompany(id,db);
    return {type:"company",id:company.id,publicId:company.public_id,name:company.company_name,path:`/companies/${company.id}/claim`};
  }
  const profile=await getProfessional(type,id,db);
  return {type,id:profile.source_id,publicId:profile.public_id,name:profile.name,path:`/professionals/${type}/${profile.source_id}/claim`};
};

export async function issueClaimInvitation(reviewer,input={},db=pool,send=sendClaimInvitationEmail,env=process.env) {
  if(env.CLAIM_INVITATIONS_ENABLED!=="true") fail(503,"INVITATIONS_DISABLED","Invitation delivery is not enabled until SMTP is verified.");
  const email=clean(input.email).toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(email) || email.length>320) fail(400,"INVALID_EMAIL","Enter a valid recipient email.");
  let origin;
  try {origin=new URL(env.FRONTEND_URL);if(!["https:","http:"].includes(origin.protocol) || (origin.protocol==="http:" && !["localhost","127.0.0.1"].includes(origin.hostname))) throw new Error();}
  catch {fail(503,"INVITATION_URL_UNAVAILABLE","Frontend URL is not configured for claim invitations.");}
  const target=await targetInfo(input.targetType,clean(input.targetId),db);
  if(target.type!=="company") {
    const linked=(await db.query(`SELECT 1 FROM professional_memberships WHERE source_type=$1 AND source_id=$2 AND status='approved'`,[target.type,target.id])).rows[0];
    if(linked) fail(409,"CONTROLLER_EXISTS","This professional profile already has a verified controller; review a dispute first.");
  }
  const token=randomBytes(32).toString("hex");
  const link=new URL(`/claim-invitations/${token}`,origin).toString();
  const row=(await db.query(`INSERT INTO profile_claim_invitations(target_type,target_id,recipient_email,token_hash,
    issued_by_user_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '48 hours') RETURNING id,expires_at`,
    [target.type,target.id,email,hash(token),reviewer.id])).rows[0];
  try {
    await send({email,claimUrl:link,targetName:target.name});
    await db.query(`UPDATE profile_claim_invitations SET status='sent',sent_at=now() WHERE id=$1 AND status='created'`,[row.id]);
  } catch {
    await db.query(`UPDATE profile_claim_invitations SET status='failed' WHERE id=$1 AND status='created'`,[row.id]);
    fail(503,"INVITATION_DELIVERY_FAILED","Invitation email was not delivered. No active invitation was issued.");
  }
  await writeAdminAudit(db,{actorUserId:reviewer.id,action:"profile_claim_invitation_sent",targetType:"profile_claim_invitation",
    targetId:row.id,summary:`Invitation sent for ${target.type}:${target.id}`});
  return {id:row.id,targetType:target.type,targetId:target.id,expiresAt:row.expires_at,status:"sent"};
}

export async function previewClaimInvitation(token,db=pool) {
  if(!TOKEN.test(String(token))) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable.");
  const row=(await db.query(`SELECT target_type,target_id FROM profile_claim_invitations
    WHERE token_hash=$1 AND status='sent' AND expires_at>now()`,[hash(token)])).rows[0];
  if(!row) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable or expired.");
  return targetInfo(row.target_type,row.target_id,db);
}

export async function redeemClaimInvitation(token,user,db=pool) {
  if(!TOKEN.test(String(token))) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable.");
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const row=(await client.query(`SELECT * FROM profile_claim_invitations WHERE token_hash=$1 FOR UPDATE`,[hash(token)])).rows[0];
    if(!row || row.status!=="sent" || new Date(row.expires_at).getTime()<=Date.now()) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable or expired.");
    if(clean(user.email).toLowerCase()!==row.recipient_email.toLowerCase()) fail(403,"INVITATION_RECIPIENT_MISMATCH","Sign in with the email address invited by NexaPort.");
    const target=await targetInfo(row.target_type,row.target_id,client);
    await client.query(`UPDATE profile_claim_invitations SET status='redeemed',redeemed_by_user_id=$1,
      redeemed_at=now() WHERE id=$2`,[user.id,row.id]);
    await writeAdminAudit(client,{actorUserId:user.id,action:"profile_claim_invitation_redeemed",targetType:"profile_claim_invitation",
      targetId:row.id,summary:`Invitation redeemed for ${row.target_type}:${row.target_id}`});
    await client.query("COMMIT");
    return target;
  } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
}
