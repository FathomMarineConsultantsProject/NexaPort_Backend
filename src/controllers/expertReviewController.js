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
    const { job_name, rating, comment, reviewer_name } = req.body;

    if (!job_name || !rating) {
      return res.status(400).json({
        success: false,
        message: "job_name and rating are required",
      });
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
      [
        expertId,
        job_name,
        rating,
        comment || null,
        reviewer_name || null,
      ]
    );

    await pool.query(
      `
      UPDATE experts
      SET
        rating = (
          SELECT ROUND(AVG(rating)::numeric, 1)
          FROM expert_reviews
          WHERE expert_id = $1
        ),
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

    res.status(201).json({
      success: true,
      message: "Review submitted successfully",
      data: result.rows[0],
    });
  } catch (error) {
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