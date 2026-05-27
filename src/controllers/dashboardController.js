import { pool } from "../config/db.js";

export const getDashboardStats = async (req, res) => {
    try {
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
            pool.query(`SELECT COUNT(*)::int AS total FROM service_requests`),

            pool.query(`
        SELECT COUNT(*)::int AS total
        FROM service_requests
        WHERE status IN ('open', 'pending', 'active')
      `),

            pool.query(`
  SELECT COUNT(*)::int AS total
  FROM experts
  WHERE availability = 'available'
`),

            pool.query(`SELECT COUNT(*)::int AS total FROM vessels`),

            pool.query(`
        SELECT 
          service_type,
          COUNT(*)::int AS count
        FROM service_requests
        GROUP BY service_type
        ORDER BY count DESC
      `),

            pool.query(`
        SELECT 
          urgency,
          COUNT(*)::int AS count
        FROM service_requests
        GROUP BY urgency
        ORDER BY count DESC
      `),

            pool.query(`
        SELECT 
          COALESCE(ROUND(AVG(budget_usd), 2), 0)::float AS avg_budget_per_request,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_requests
        FROM service_requests
      `),

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
        console.error("Dashboard stats error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard stats",
            error: error.message,
        });
    }
};