import express from "express";
import { randomUUID } from "node:crypto";
import { requireAuth,allowRoles } from "../middlewares/authMiddleware.js";
import { listAdminProfileClaims } from "../services/adminProfileClaimsService.js";
const router=express.Router();
router.use(requireAuth,allowRoles(1));
router.get("/",async(req,res)=>{try{res.json({success:true,data:await listAdminProfileClaims(req.query)});}
  catch(error){if(!error.status)console.error(`[profile-claims:${randomUUID()}]`,error);
    res.status(error.status||500).json({success:false,code:error.code||"PROFILE_CLAIMS_FAILED",message:error.status?error.message:"Unable to load profile claims."});}});
export default router;
