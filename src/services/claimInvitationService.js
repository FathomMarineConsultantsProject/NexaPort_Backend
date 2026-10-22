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
    return {type:"company",id:company.id,publicId:company.nexaport_company_id,legacyPublicId:company.public_id,name:company.company_name,path:`/companies/${company.id}/claim`};
  }
  const profile=await getProfessional(type,id,db);
  return {type,id:profile.source_id,publicId:profile.public_id,name:profile.name,path:`/professionals/${type}/${profile.source_id}/claim`};
};

export async function issueClaimInvitation(reviewer,input={},db=pool,send=sendClaimInvitationEmail,env=process.env) {
  const mode=input.mode === "link" ? "link" : input.mode === undefined || input.mode === "email" ? "email" : null;
  if(!mode) fail(400,"INVALID_MODE","Select email or manual link.");
  const email=clean(input.email).toLowerCase();
  if((mode==="email" || email) && (!/^\S+@\S+\.\S+$/.test(email) || email.length>320)) fail(400,"INVALID_EMAIL","Enter a valid recipient email.");
  if(mode==="email" && env.CLAIM_INVITATIONS_ENABLED!=="true") fail(503,"INVITATIONS_DISABLED","Invitation email is disabled in this backend environment. Generate a claim link instead.");
  if(mode==="email" && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !(env.SMTP_FROM_EMAIL || env.SMTP_USER)))
    fail(503,"SMTP_UNAVAILABLE","Invitation email transport is not configured.");
  let origin;
  try {origin=new URL(env.FRONTEND_URL || "https://nexa-port-frontend.vercel.app");if(!["https:","http:"].includes(origin.protocol) || (origin.protocol==="http:" && !["localhost","127.0.0.1"].includes(origin.hostname))) throw new Error();}
  catch {fail(503,"INVITATION_URL_UNAVAILABLE","Frontend URL is not configured for claim invitations.");}
  const target=await targetInfo(input.targetType,clean(input.targetId),db);
  if(mode==="link" && !email) {
    const url=new URL(target.path,origin).toString();
    await writeAdminAudit(db,{actorUserId:reviewer.id,action:"profile_claim_share_link_created",targetType:target.type,
      targetId:target.id,summary:`Shareable claim page generated for ${target.type}:${target.id}`});
    return {targetType:target.type,targetId:target.id,status:"shareable",url};
  }
  if(target.type!=="company") {
    const linked=(await db.query(`SELECT 1 FROM professional_memberships WHERE source_type=$1 AND source_id=$2 AND status='approved'`,[target.type,target.id])).rows[0];
    if(linked) fail(409,"CONTROLLER_EXISTS","This professional profile already has a verified controller; review a dispute first.");
  }
  const token=randomBytes(32).toString("hex");
  const link=new URL(`/claim-invitations/${token}`,origin).toString();
  await db.query(`UPDATE profile_claim_invitations SET status='revoked',revoked_at=now()
    WHERE target_type=$1 AND target_id=$2 AND recipient_email=$3 AND status IN ('created','ready','sent') AND expires_at<=now()`,
    [target.type,target.id,email]);
  let row;
  try {row=(await db.query(`INSERT INTO profile_claim_invitations(target_type,target_id,recipient_email,token_hash,
    issued_by_user_id,expires_at,status) VALUES($1,$2,$3,$4,$5,now()+interval '48 hours',$6) RETURNING id,expires_at`,
    [target.type,target.id,email,hash(token),reviewer.id,mode==="link"?"ready":"created"])).rows[0];}
  catch(error){if(error.code==="23505") fail(409,"INVITATION_EXISTS","An active invitation already exists for this recipient and profile. Revoke it before issuing another.");throw error;}
  if(mode==="link") {
    try {await writeAdminAudit(db,{actorUserId:reviewer.id,action:"profile_claim_invitation_link_created",targetType:"profile_claim_invitation",
      targetId:row.id,summary:`Manual invitation created for ${target.type}:${target.id}`});}
    catch(error){await db.query("UPDATE profile_claim_invitations SET status='revoked',revoked_at=now() WHERE id=$1 AND status='ready'",[row.id]);throw error;}
    return {id:row.id,targetType:target.type,targetId:target.id,recipientEmail:email,expiresAt:row.expires_at,status:"ready",url:link};
  }
  try {
    await send({email,claimUrl:link,targetName:target.name});
  } catch {
    await db.query(`UPDATE profile_claim_invitations SET status='failed' WHERE id=$1 AND status='created'`,[row.id]);
    fail(503,"INVITATION_DELIVERY_FAILED","Invitation email was not accepted by the mail transport. No active invitation was issued.");
  }
  await db.query(`UPDATE profile_claim_invitations SET status='sent',sent_at=now() WHERE id=$1 AND status='created'`,[row.id]);
  await writeAdminAudit(db,{actorUserId:reviewer.id,action:"profile_claim_invitation_sent",targetType:"profile_claim_invitation",
    targetId:row.id,summary:`Invitation sent for ${target.type}:${target.id}`});
  return {id:row.id,targetType:target.type,targetId:target.id,expiresAt:row.expires_at,status:"sent"};
}

export async function revokeClaimInvitation(id,reviewer,db=pool) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id))) fail(400,"INVALID_ID","Invalid invitation ID.");
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const row=(await client.query(`UPDATE profile_claim_invitations SET status='revoked',revoked_at=now()
      WHERE id=$1 AND status IN ('created','ready','sent') RETURNING target_type,target_id`,[id])).rows[0];
    if(!row) fail(404,"INVITATION_UNAVAILABLE","Active invitation not found.");
    await writeAdminAudit(client,{actorUserId:reviewer.id,action:"profile_claim_invitation_revoked",targetType:"profile_claim_invitation",
      targetId:id,summary:`Invitation revoked for ${row.target_type}:${row.target_id}`});
    await client.query("COMMIT");return {id,status:"revoked"};
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

export async function listClaimInvitations(input={},db=pool) {
  const target=await targetInfo(input.targetType,clean(input.targetId),db);
  return (await db.query(`SELECT id,recipient_email,
    CASE WHEN status IN ('ready','sent') AND expires_at<=now() THEN 'expired' ELSE status END AS status,
    expires_at,created_at,sent_at,redeemed_at,revoked_at
    FROM profile_claim_invitations WHERE target_type=$1 AND target_id=$2
    ORDER BY created_at DESC LIMIT 25`,[target.type,target.id])).rows;
}

export async function previewClaimInvitation(token,db=pool) {
  if(!TOKEN.test(String(token))) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable.");
  const row=(await db.query(`SELECT target_type,target_id FROM profile_claim_invitations
    WHERE token_hash=$1 AND status IN ('ready','sent') AND expires_at>now()`,[hash(token)])).rows[0];
  if(!row) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable or expired.");
  return targetInfo(row.target_type,row.target_id,db);
}

export async function redeemClaimInvitation(token,user,db=pool) {
  if(!TOKEN.test(String(token))) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable.");
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const row=(await client.query(`SELECT * FROM profile_claim_invitations WHERE token_hash=$1 FOR UPDATE`,[hash(token)])).rows[0];
    if(!row || !["ready","sent"].includes(row.status) || new Date(row.expires_at).getTime()<=Date.now()) fail(404,"INVITATION_UNAVAILABLE","Invitation is unavailable or expired.");
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
