import { pool } from "../config/db.js";

export const getDashboardStats = async (req, res) => {
  try {
    const roleId = Number(req.user.role_id);
    const userId = Number(req.user.id);

    let requestWhere = "";
    let vesselWhere = "";
    const requestValues = [];
    const vesselValues = [];

    if (roleId === 2) {
      requestWhere = `WHERE moderation_status = 'approved' AND LOWER(status) IN ('open', 'pending', 'active')`;
    }

    if (roleId === 3) {
      requestValues.push(userId);
      requestWhere = `WHERE requester_user_id = $1`;

      vesselValues.push(userId);
      vesselWhere = `WHERE created_by_user_id = $1 AND is_active = true`;
    } else {
      vesselWhere = `WHERE is_active = true`;
    }

    const [
      totalRequests,
      openRequests,
      verifiedExperts,
      vesselsRegistered,
      requestsByServiceType,
      urgencyDistribution,
      financialOverview,
      topRatedExperts,
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total FROM service_requests ${requestWhere}`,
        requestValues
      ),

      pool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM service_requests
        ${requestWhere ? `${requestWhere} AND` : "WHERE"}
        LOWER(status) IN ('open', 'pending', 'active')
        `,
        requestValues
      ),

      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM experts
        WHERE availability = 'available'
      `),

      pool.query(
        `SELECT COUNT(*)::int AS total FROM vessels ${vesselWhere}`,
        vesselValues
      ),

      pool.query(
        `
        SELECT service_type, COUNT(*)::int AS count
        FROM service_requests
        ${requestWhere}
        GROUP BY service_type
        ORDER BY count DESC
        `,
        requestValues
      ),

      roleId === 2
        ? Promise.resolve({ rows: [] })
        : pool.query(
          `SELECT urgency, COUNT(*)::int AS count FROM service_requests ${requestWhere} GROUP BY urgency ORDER BY count DESC`,
          requestValues
        ),

      roleId === 2
        ? Promise.resolve({ rows: [{ avg_budget_per_request: 0, completed_requests: 0 }] })
        : pool.query(
          `SELECT COALESCE(ROUND(AVG(budget_usd), 2), 0)::float AS avg_budget_per_request,
                  COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_requests
           FROM service_requests ${requestWhere}`,
          requestValues
        ),

      pool.query(`
        SELECT 
          id,
          full_name,
          base_location,
          country,
          is_premium,
          rating,
          review_count
        FROM experts
        ORDER BY rating DESC, review_count DESC
        LIMIT 5
      `),
    ]);

    res.json({
      success: true,
      data: {
        role_id: roleId,
        cards: {
          total_requests: totalRequests.rows[0].total,
          open_requests: openRequests.rows[0].total,
          verified_experts: verifiedExperts.rows[0].total,
          vessels_registered: vesselsRegistered.rows[0].total,
        },
        requests_by_service_type: requestsByServiceType.rows,
        urgency_distribution: urgencyDistribution.rows,
        financial_overview: financialOverview.rows[0],
        top_rated_experts: topRatedExperts.rows,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard stats",
      error: error.message,
    });
  }
};
