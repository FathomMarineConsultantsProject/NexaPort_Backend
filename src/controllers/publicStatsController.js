import { pool } from "../config/db.js";

export const getPlatformStats = async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (
          SELECT COUNT(DISTINCT u.id)::int
          FROM public.users u
          INNER JOIN public.experts e
            ON e.user_id = u.id
          WHERE u.role_id = 2
            AND u.is_active = TRUE
        ) AS nexaport_consultants,

        (
          SELECT COUNT(*)::int
          FROM public.flag_inspectors
          WHERE COALESCE(is_active, TRUE) = TRUE
        ) AS flag_inspectors,

        (
          SELECT COUNT(*)::int
          FROM public.accredited_inspectors
          WHERE COALESCE(is_active, TRUE) = TRUE
        ) AS accredited_inspectors,

        (
          SELECT COUNT(*)::int
          FROM public.appointed_ship_surveyors
          WHERE COALESCE(is_active, TRUE) = TRUE
        ) AS appointed_ship_surveyors,

        (
          SELECT COUNT(*)::int
          FROM public.ports
        ) AS ports_total
    `);

    const stats = result.rows[0];

    const breakdown = {
      nexaport_consultants: Number(stats.nexaport_consultants || 0),
      flag_inspectors: Number(stats.flag_inspectors || 0),
      accredited_inspectors: Number(stats.accredited_inspectors || 0),
      appointed_ship_surveyors: Number(
        stats.appointed_ship_surveyors || 0
      ),
    };

    const maritimeProfessionalsTotal = Object.values(breakdown).reduce(
      (sum, count) => sum + count,
      0
    );

    const actualPortsTotal = Number(stats.ports_total || 0);

    const displayedPortsTotal = actualPortsTotal;

    const actualGlobalCoverageTotal =
      maritimeProfessionalsTotal + actualPortsTotal;

    const globalPresenceScore =
      actualGlobalCoverageTotal;

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    return res.json({
      success: true,
      data: {
        maritime_professionals_total:
          maritimeProfessionalsTotal,

        ports_total:
          displayedPortsTotal,

        actual_ports_total:
          actualPortsTotal,

        actual_global_coverage_total:
          actualGlobalCoverageTotal,

        global_presence_score:
          globalPresenceScore,

        breakdown,

        directory_entries_total:
          maritimeProfessionalsTotal,

        updated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      "Failed to load public platform statistics",
      {
        message: error.message,
        stack: error.stack,
      }
    );

    return res.status(500).json({
      success: false,
      message:
        "Platform statistics are temporarily unavailable.",
    });
  }
};