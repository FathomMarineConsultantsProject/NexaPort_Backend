import { provisionAdminAccount } from "../services/adminAccountProvisioningService.js";

export const createAccountAsAdmin = async (req, res) => {
  try {
    const result = await provisionAdminAccount({ actor: req.user, body: req.body });
    return res.status(result.created ? 201 : 200).json({ success: true, data: result });
  } catch (error) {
    // Do not log request bodies, passwords, hashes or session tokens.
    return res.status(error.status || 500).json({ success: false,
      code: error.status ? error.code : "ACCOUNT_PROVISIONING_FAILED",
      message: error.status ? error.message : "Account provisioning failed; no partial account was committed." });
  }
};
