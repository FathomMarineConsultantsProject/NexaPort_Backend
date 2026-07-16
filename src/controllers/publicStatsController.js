import { pool } from "../config/db.js";

export const getPlatformStats = async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(DISTINCT u.id)::int FROM public.users u JOIN public.experts e ON e.user_id=u.id WHERE u.role_id=2 AND u.is_active=TRUE) AS nexaport_consultants,
        (SELECT COUNT(*)::int FROM public.flag_inspectors WHERE COALESCE(is_active,TRUE)=TRUE) AS flag_inspectors,
        (SELECT COUNT(*)::int FROM public.accredited_inspectors WHERE COALESCE(is_active,TRUE)=TRUE) AS accredited_inspectors,
        (SELECT COUNT(*)::int FROM public.appointed_ship_surveyors WHERE COALESCE(is_active,TRUE)=TRUE) AS appointed_ship_surveyors
    `);
    const breakdown = result.rows[0];
    const maritimeProfessionalsTotal = Object.values(breakdown).reduce((sum, count) => sum + Number(count || 0), 0);
    res.set("Cache-Control", "public, max-age=60, s-maxage=120");
    return res.json({
      success: true,
      data: {
        maritime_professionals_total: maritimeProfessionalsTotal,
        breakdown,
        directory_entries_total: maritimeProfessionalsTotal,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to load public platform statistics", { error });
    return res.status(500).json({ success: false, message: "Platform statistics are temporarily unavailable." });
  }
};
