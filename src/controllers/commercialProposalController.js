import { pool } from "../config/db.js";
import {
  approveProposalByClient,
  createOrUpdateDraftProposal,
  getActiveProposalForRequest,
  getProposalById,
  getProposalsForRequest,
  mapProposalRow,
  rejectProposalByClient,
  sendProposalToClient,
  supersedeProposal,
} from "../services/commercialProposalService.js";

const sendError = (res, error) => {
  console.error("Commercial proposal error:", error);
  return res.status(error.status || 500).json({
    success: false,
    code: error.code || "COMMERCIAL_PROPOSAL_ERROR",
    message: error.status ? error.message : "Unable to process commercial proposal",
  });
};

export const getActiveProposal = async (req, res) => {
  try {
    const requestId = req.params.id || req.params.requestId;
    const proposal = await getActiveProposalForRequest(requestId);
    if (!proposal) {
      return res.json({ success: true, data: null });
    }

    // Role 3 can only view proposal if it's sent or approved, and if they own the request
    if (Number(req.user.role_id) === 3) {
      const requestCheck = await pool.query(
        "SELECT requester_user_id FROM service_requests WHERE id = $1",
        [requestId]
      );
      if (
        !requestCheck.rows.length ||
        Number(requestCheck.rows[0].requester_user_id) !== Number(req.user.id)
      ) {
        return res.status(403).json({ success: false, message: "Access denied." });
      }
      if (!["sent", "approved", "rejected"].includes(proposal.status)) {
        return res.json({ success: true, data: null });
      }
    }

    res.json({
      success: true,
      data: mapProposalRow(proposal, req.user),
    });
  } catch (error) {
    sendError(res, error);
  }
};

export const listProposals = async (req, res) => {
  try {
    const requestId = req.params.id || req.params.requestId;
    const rows = await getProposalsForRequest(requestId);
    res.json({
      success: true,
      data: rows.map((r) => mapProposalRow(r, req.user)),
    });
  } catch (error) {
    sendError(res, error);
  }
};

export const saveDraft = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const requestId = req.params.id || req.params.requestId;
    const {
      quotationId,
      adminMarkupUsd,
      clientNotes,
      internalAdminNotes,
      estimatedAttendanceDays,
    } = req.body;

    const proposal = await createOrUpdateDraftProposal({
      requestId,
      quotationId,
      adminMarkupUsd,
      clientNotes,
      internalAdminNotes,
      estimatedAttendanceDays,
      actorUserId: req.user.id,
      queryable: client,
    });

    await client.query("COMMIT");
    res.json({
      success: true,
      message: "Draft commercial proposal saved.",
      data: mapProposalRow(proposal, req.user),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    sendError(res, error);
  } finally {
    client.release();
  }
};

export const sendProposal = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const requestId = req.params.id || req.params.requestId;
    const { proposalId } = req.body || {};

    const proposal = await sendProposalToClient({
      requestId,
      proposalId,
      actorUserId: req.user.id,
      queryable: client,
    });

    await client.query("COMMIT");
    res.json({
      success: true,
      message: "Commercial proposal sent to Client successfully.",
      data: mapProposalRow(proposal, req.user),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    sendError(res, error);
  } finally {
    client.release();
  }
};

export const recallProposal = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const requestId = req.params.id || req.params.requestId;
    const { proposalId } = req.body || {};

    const proposal = await supersedeProposal({
      requestId,
      proposalId,
      actorUserId: req.user.id,
      queryable: client,
    });

    await client.query("COMMIT");
    res.json({
      success: true,
      message: "Commercial proposal recalled and superseded.",
      data: mapProposalRow(proposal, req.user),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    sendError(res, error);
  } finally {
    client.release();
  }
};

export const approveProposal = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const proposalId = req.body?.proposalId || req.params.proposalId;

    if (!proposalId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "proposalId is required for approval.",
      });
    }

    const result = await approveProposalByClient({
      proposalId,
      actorUserId: req.user.id,
      queryable: client,
    });

    await client.query("COMMIT");
    res.json({
      success: true,
      message: "Commercial proposal approved. Consultant assignment confirmed.",
      data: mapProposalRow(result.proposal, req.user),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    sendError(res, error);
  } finally {
    client.release();
  }
};

export const rejectProposal = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const proposalId = req.body?.proposalId || req.params.proposalId;
    const { rejectionReason } = req.body || {};

    if (!proposalId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "proposalId is required.",
      });
    }

    const proposal = await rejectProposalByClient({
      proposalId,
      rejectionReason,
      actorUserId: req.user.id,
      queryable: client,
    });

    await client.query("COMMIT");
    res.json({
      success: true,
      message: "Commercial proposal declined.",
      data: mapProposalRow(proposal, req.user),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    sendError(res, error);
  } finally {
    client.release();
  }
};
