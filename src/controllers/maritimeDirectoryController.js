import { randomUUID } from "node:crypto";
import {
  createMaritimeEntity,
  getMaritimeEntity,
  listMaritimeEntities,
  setMaritimeEntityState,
  updateMaritimeEntity,
} from "../services/maritimeDirectoryService.js";

const respondError = (res, error, correlationId) => {
  const status = error.status || 500;
  if (status >= 500) console.error(`[maritime-directory:${correlationId}]`, error);
  return res.status(status).json({
    success: false,
    code: error.code || "MARITIME_DIRECTORY_REQUEST_FAILED",
    message: status >= 500 ? "The directory request could not be completed." : error.message,
    ...(error.fieldErrors ? { field_errors: error.fieldErrors } : {}),
    correlation_id: correlationId,
  });
};

const handler = (work, status = 200) => async (req, res) => {
  const correlationId = randomUUID();
  try { return res.status(status).json({ success: true, ...(await work(req)) }); }
  catch (error) { return respondError(res, error, correlationId); }
};

export const listDirectory = handler(async (req) => listMaritimeEntities(req.query));
export const getDirectoryEntity = handler(async (req) => ({ data: await getMaritimeEntity(req.params.entityId) }));
export const createDirectoryEntity = handler(async (req) => ({ data: await createMaritimeEntity(req.body, req.user.id) }), 201);
export const updateDirectoryEntity = handler(async (req) => ({ data: await updateMaritimeEntity(req.params.entityId, req.body, req.user.id) }));
export const approveDirectoryEntity = handler(async (req) => ({ data: await setMaritimeEntityState(req.params.entityId, "approve", req.user.id) }));
export const rejectDirectoryEntity = handler(async (req) => ({ data: await setMaritimeEntityState(req.params.entityId, "reject", req.user.id, req.body?.reason) }));
export const activateDirectoryEntity = handler(async (req) => ({ data: await setMaritimeEntityState(req.params.entityId, "activate", req.user.id) }));
export const deactivateDirectoryEntity = handler(async (req) => ({ data: await setMaritimeEntityState(req.params.entityId, "deactivate", req.user.id, req.body?.reason) }));
