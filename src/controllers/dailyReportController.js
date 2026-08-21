import {
  attachDailyReportPhoto, createDailyReport, createDailyReportPhotoUpload, finalizeDailyReport,
  generateDailyReport, getDailyReport, listDailyReports, removeDailyReportPhoto, updateDailyReport,
} from "../services/dailyReportService.js";

const sendError = (res, error) => {
  console.error("Daily Report error:", error);
  return res.status(error.status || 500).json({
    success: false,
    code: error.code || "DAILY_REPORT_ERROR",
    message: error.status ? error.message : "Unable to process the Daily Report",
    ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
  });
};

export const list = async (req, res) => { try { res.json({ success: true, data: await listDailyReports(req.params.requestId) }); } catch (error) { sendError(res, error); } };
export const get = async (req, res) => { try { res.json({ success: true, data: await getDailyReport(req.params.requestId, req.params.dailyReportId) }); } catch (error) { sendError(res, error); } };
export const create = async (req, res) => { try { res.status(201).json({ success: true, message: "Daily Report created", data: await createDailyReport({ requestId: req.params.requestId, actorUserId: req.user.id, input: req.body }) }); } catch (error) { sendError(res, error); } };
export const update = async (req, res) => { try { res.json({ success: true, message: "Daily Report draft saved", data: await updateDailyReport({ requestId: req.params.requestId, dailyReportId: req.params.dailyReportId, actorUserId: req.user.id, input: req.body }) }); } catch (error) { sendError(res, error); } };
export const generate = async (req, res) => { try { res.json({ success: true, message: "Daily Report PDF generated", data: await generateDailyReport({ requestId: req.params.requestId, dailyReportId: req.params.dailyReportId, actorUserId: req.user.id }) }); } catch (error) { sendError(res, error); } };
export const finalize = async (req, res) => { try { res.json({ success: true, message: "Daily Report finalized", data: await finalizeDailyReport({ requestId: req.params.requestId, dailyReportId: req.params.dailyReportId, actorUserId: req.user.id }) }); } catch (error) { sendError(res, error); } };
export const photoUpload = async (req, res) => { try { res.json({ success: true, data: await createDailyReportPhotoUpload({ requestId: req.params.requestId, dailyReportId: req.params.dailyReportId, ...req.body }) }); } catch (error) { sendError(res, error); } };
export const attachPhoto = async (req, res) => { try { res.json({ success: true, message: "Daily Report photograph attached", data: await attachDailyReportPhoto({ requestId: req.params.requestId, dailyReportId: req.params.dailyReportId, actorUserId: req.user.id, input: req.body }) }); } catch (error) { sendError(res, error); } };
export const removePhoto = async (req, res) => { try { res.json({ success: true, message: "Daily Report photograph removed", data: await removeDailyReportPhoto({ requestId: req.params.requestId, dailyReportId: req.params.dailyReportId, photoId: req.params.photoId, actorUserId: req.user.id }) }); } catch (error) { sendError(res, error); } };

