import { pool } from "../config/db.js";

export const getExpertReviews = async (req, res) => {
  try {
    const { expertId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM expert_reviews
      WHERE expert_id = $1
      ORDER BY created_at DESC
      `,
      [expertId]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch expert reviews",
      error: error.message,
    });
  }
};

export const createExpertReview = async (req, res) => {
  try {
    const { expertId } = req.params;
    const { serviceRequestId, job_name, rating, comment, reviewer_name } = req.body;

    if (!job_name || !rating) {
      return res.status(400).json({
        success: false,
        message: "job_name and rating are required",
      });
    }

    const expertResult = await pool.query(
      `
      SELECT id, user_id
      FROM experts
      WHERE id = $1 OR user_id = $1
      LIMIT 1
      `,
      [Number(expertId)]
    );

    if (!expertResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Expert profile not found",
      });
    }

    const expert = expertResult.rows[0];

    if (Number(req.user.role_id) === 3) {
      const allowed = await pool.query(
        `
        SELECT sr.id
        FROM service_requests sr
        LEFT JOIN quotations q
          ON q.service_request_id = sr.id
          AND q.status = 'accepted'
        WHERE sr.created_by_user_id = $1
          AND sr.status IN ('assigned', 'completed')
          AND ($4::int IS NULL OR sr.id = $4)
          AND (
            sr.accepted_expert_id = $2
            OR sr.accepted_expert_id = $3
            OR q.expert_id = $2
            OR q.expert_id = $3
          )
        LIMIT 1
        `,
        [
          req.user.id,
          expert.id,
          expert.user_id,
          serviceRequestId ? Number(serviceRequestId) : null,
        ]
      );

      if (!allowed.rows.length) {
        return res.status(403).json({
          success: false,
          message: "You can review only the accepted expert for your request",
        });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO expert_reviews (
        expert_id,
        job_name,
        rating,
        comment,
        reviewer_name
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [expert.id, job_name, rating, comment || null, reviewer_name || null]
    );

    await pool.query(
      `
      UPDATE experts
      SET
        rating = COALESCE((
          SELECT ROUND(AVG(rating)::numeric, 1)
          FROM expert_reviews
          WHERE expert_id = $1
        ), 0),
        review_count = (
          SELECT COUNT(*)
          FROM expert_reviews
          WHERE expert_id = $1
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [expert.id]
    );

    res.status(201).json({
      success: true,
      message: "Review submitted successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("REVIEW CREATE ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create expert review",
      error: error.message,
    });
  }
};

export const deleteExpertReview = async (req, res) => {
  try {
    const { reviewId } = req.params;

    const deleted = await pool.query(
      `DELETE FROM expert_reviews WHERE id = $1 RETURNING *`,
      [reviewId]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Review not found",
      });
    }

    const expertId = deleted.rows[0].expert_id;

    await pool.query(
      `
      UPDATE experts
      SET
        rating = COALESCE((
          SELECT ROUND(AVG(rating)::numeric, 1)
          FROM expert_reviews
          WHERE expert_id = $1
        ), 0),
        review_count = (
          SELECT COUNT(*)
          FROM expert_reviews
          WHERE expert_id = $1
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [expertId]
    );

    res.json({
      success: true,
      message: "Review deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete review",
      error: error.message,
    });
  }
};