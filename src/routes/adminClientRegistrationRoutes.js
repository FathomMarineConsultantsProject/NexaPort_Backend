import express from "express";

import {
  requireAuth,
  allowRoles,
} from "../middlewares/authMiddleware.js";

import {
  approveClientRegistration,
  getClientDocumentDownloadUrl,
  getClientRegistration,
  listClientRegistrations,
  rejectClientRegistration,
} from "../controllers/adminClientRegistrationController.js";

import {
  createClientRegistrationDraft,
  presignClientRegistrationDocument,
  confirmClientRegistrationDocument,
  registerClient,
} from "../controllers/clientRegistrationController.js";

const router = express.Router();

/*
 * All routes in this file are restricted to Super Admin.
 * Role 1 = Super Admin
 */
router.use(requireAuth, allowRoles(1));

/* =========================================================
   SUPER ADMIN: REGISTER CLIENT ON BEHALF OF CLIENT
========================================================= */

/*
 * Step 1:
 * Create the client registration draft.
 *
 * POST:
 * /api/admin/client-registrations/create/draft
 */
router.post(
  "/create/draft",
  createClientRegistrationDraft
);

/*
 * Step 2:
 * Generate an S3 upload URL for a verification document.
 *
 * POST:
 * /api/admin/client-registrations/create/documents/upload-url
 */
router.post(
  "/create/documents/upload-url",
  presignClientRegistrationDocument
);

/*
 * Step 3:
 * Confirm that a verification document was uploaded.
 *
 * POST:
 * /api/admin/client-registrations/create/documents/confirm
 */
router.post(
  "/create/documents/confirm",
  confirmClientRegistrationDocument
);

/*
 * Final step:
 * Submit and create the Client account.
 *
 * POST:
 * /api/admin/client-registrations/create/submit
 */
router.post(
  "/create/submit",
  registerClient
);

/* =========================================================
   SUPER ADMIN: VIEW AND MANAGE CLIENT REGISTRATIONS
========================================================= */

/*
 * GET:
 * /api/admin/client-registrations
 */
router.get(
  "/",
  listClientRegistrations
);

/*
 * GET:
 * /api/admin/client-registrations/:id
 */
router.get(
  "/:id",
  getClientRegistration
);

/*
 * GET:
 * /api/admin/client-registrations/:clientProfileId/documents/:documentId/download-url
 */
router.get(
  "/:clientProfileId/documents/:documentId/download-url",
  getClientDocumentDownloadUrl
);

/*
 * POST:
 * /api/admin/client-registrations/:id/approve
 */
router.post(
  "/:id/approve",
  approveClientRegistration
);

/*
 * POST:
 * /api/admin/client-registrations/:id/reject
 */
router.post(
  "/:id/reject",
  rejectClientRegistration
);

export default router;