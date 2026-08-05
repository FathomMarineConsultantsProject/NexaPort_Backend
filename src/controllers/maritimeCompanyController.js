import { createToken } from "./authController.js";
import {
  getOwnedMaritimeCompany,
  createCompanyLogoUpload,
  confirmCompanyLogoUpload,
  registerMaritimeCompany,
  updateOwnedMaritimeCompany,
} from "../services/maritimeCompanyService.js";

const sendError = (res, error) => res.status(error.status || 500).json({
  success: false,
  code: error.code || "MARITIME_COMPANY_REQUEST_FAILED",
  message: error.status ? error.message : "The company request could not be completed.",
  ...(error.fieldErrors ? { field_errors: error.fieldErrors } : {}),
});

export const registerCompany = async (req, res) => {
  try {
    const result = await registerMaritimeCompany(req.body);
    return res.status(201).json({
      success: true,
      message: "Company account submitted for review.",
      token: createToken(result.user),
      user: result.user,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getCompanyProfile = async (req, res) => {
  try { return res.json({ success: true, data: await getOwnedMaritimeCompany(req.user.id) }); }
  catch (error) { return sendError(res, error); }
};

export const updateCompanyProfile = async (req, res) => {
  try { return res.json({ success: true, data: await updateOwnedMaritimeCompany(req.user.id, req.body) }); }
  catch (error) { return sendError(res, error); }
};

export const presignCompanyLogo = async (req, res) => {
  try { return res.json({ success: true, data: await createCompanyLogoUpload(req.user.id, req.body) }); }
  catch (error) { return sendError(res, error); }
};

export const confirmCompanyLogo = async (req, res) => {
  try { return res.json({ success: true, data: await confirmCompanyLogoUpload(req.user.id, req.body) }); }
  catch (error) { return sendError(res, error); }
};
