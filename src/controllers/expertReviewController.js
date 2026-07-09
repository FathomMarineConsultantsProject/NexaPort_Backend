import { pool } from "../config/db.js";

const isValidRating = (rating) => {
  if (rating === null || rating === undefined || rating === "") return false;
  const normalizedRating = Number(rating);
  return (
    Number.isFinite(normalizedRating) &&
    Number.isInteger(normalizedRating) &&
    normalizedRating >= 1 &&
    normalizedRating <= 5
  );
};

const shapeReview = (review, canEdit = false) => ({
  id: review.id,
  expert_id: review.expert_id,
  job_name: review.job_name,
  rating: review.rating,
  comment: review.comment,
  reviewer_name: review.reviewer_name,
  created_at: review.created_at,
  can_edit: canEdit,
});

const recalculateExpertReviewStats = async (expertId) => {
  const aggregate = await pool.query(
    `
    SELECT
      COALESCE(ROUND(AVG(rating)::numeric, 1), 0) AS average_rating,
      COUNT(*)::int AS review_count
    FROM expert_reviews
    WHERE expert_id = $1
    `,
    [expertId]
  );
  const { average_rating, review_count } = aggregate.rows[0];

  await pool.query(
    `
    UPDATE experts
    SET
      rating = $2,
      review_count = $3,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    `,
    [expertId, average_rating, review_count]
  );
};

export const getExpertReviews = async (req, res) => {
  try {
    const { expertId } = req.params;
    const result = await pool.query(
      `
      SELECT
        id,
        expert_id,
        reviewer_user_id,
        job_name,
        rating,
        comment,
        reviewer_name,
        created_at
      FROM expert_reviews
      WHERE expert_id = $1
      ORDER BY created_at DESC
      `,
      [expertId]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map((review) =>
        shapeReview(
          review,
          Number(req.user.role_id) === 3 &&
            review.reviewer_user_id !== null &&
            Number(review.reviewer_user_id) === Number(req.user.id)
        )
      ),
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

    const requesterRoleId = Number(req.user.role_id);
    if (requesterRoleId !== 1 && requesterRoleId !== 3) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to submit expert reviews",
      });
    }

    if (!job_name || !isValidRating(rating)) {
      return res.status(400).json({
        success: false,
        message: "job_name and an integer rating from 1 to 5 are required",
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
    if (requesterRoleId === 3) {
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
        reviewer_user_id,
        job_name,
        rating,
        comment,
        reviewer_name
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, expert_id, job_name, rating, comment, reviewer_name, created_at
      `,
      [
        expert.id,
        req.user.id,
        job_name,
        Number(rating),
        comment || null,
        reviewer_name || null,
      ]
    );

    await recalculateExpertReviewStats(expert.id);

    res.status(201).json({
      success: true,
      message: "Review submitted successfully",
      data: shapeReview(result.rows[0], true),
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

export const updateExpertReview = async (req, res) => {
  try {
    const reviewId = Number(req.params.reviewId);
    const { job_name, rating, comment, reviewer_name } = req.body;

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid review ID is required",
      });
    }

    if (Number(req.user.role_id) !== 3) {
      return res.status(403).json({
        success: false,
        message: "Only clients can update expert reviews",
      });
    }

    if (!job_name || !isValidRating(rating)) {
      return res.status(400).json({
        success: false,
        message: "job_name and an integer rating from 1 to 5 are required",
      });
    }

    const existing = await pool.query(
      `
      SELECT id, expert_id, reviewer_user_id
      FROM expert_reviews
      WHERE id = $1
      `,
      [reviewId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Review not found",
      });
    }

    const review = existing.rows[0];
    if (
      review.reviewer_user_id === null ||
      Number(review.reviewer_user_id) !== Number(req.user.id)
    ) {
      return res.status(403).json({
        success: false,
        message: "You can update only reviews you created",
      });
    }

    const updated = await pool.query(
      `
      UPDATE expert_reviews
      SET
        job_name = $2,
        rating = $3,
        comment = $4,
        reviewer_name = $5
      WHERE id = $1
      RETURNING id, expert_id, job_name, rating, comment, reviewer_name, created_at
      `,
      [
        reviewId,
        job_name,
        Number(rating),
        comment || null,
        reviewer_name || null,
      ]
    );

    await recalculateExpertReviewStats(review.expert_id);

    res.json({
      success: true,
      message: "Review updated successfully",
      data: shapeReview(updated.rows[0], true),
    });
  } catch (error) {
    console.error("REVIEW UPDATE ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update expert review",
      error: error.message,
    });
  }
};

export const deleteExpertReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const deleted = await pool.query(
      `DELETE FROM expert_reviews WHERE id = $1 RETURNING expert_id`,
      [reviewId]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Review not found",
      });
    }

    await recalculateExpertReviewStats(deleted.rows[0].expert_id);

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
