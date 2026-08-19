import { pool } from "../config/db.js";

const sendDashboardError = (res, label, error) => {
  console.error(`${label} dashboard error:`, error);
  return res.status(500).json({
    success: false,
    message: `Failed to fetch ${label.toLowerCase()} dashboard`,
  });
};

const requestListSelect = `
  sr.id,
  sr.title,
  sr.service_type,
  sr.service_category,
  sr.service_type_other,
  sr.vessel_name,
  sr.vessel_type,
  sr.port_name,
  sr.required_by,
  sr.eta,
  sr.status,
  sr.moderation_status,
  sr.created_at,
  sr.updated_at
`;

export const getClientDashboard = async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const [summary, attention, activeJobs, upcoming, recent] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_requests,
          COUNT(*) FILTER (WHERE LOWER(sr.status) = 'open')::int AS open_requests,
          COUNT(*) FILTER (
            WHERE sr.moderation_status = 'approved'
              AND LOWER(sr.status) = 'open'
              AND NOT EXISTS (
                SELECT 1 FROM quotations q
                WHERE q.service_request_id = sr.id AND q.status = 'accepted'
              )
          )::int AS requests_awaiting_quotes,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM quotations q
              WHERE q.service_request_id = sr.id AND q.status = 'accepted'
            )
          )::int AS quotes_received,
          COUNT(*) FILTER (
            WHERE sr.accepted_quotation_id IS NOT NULL
              AND LOWER(sr.status) IN ('open', 'pending')
          )::int AS awaiting_decision,
          COUNT(*) FILTER (WHERE LOWER(sr.status) IN ('assigned', 'active'))::int AS active_jobs,
          COUNT(*) FILTER (WHERE LOWER(sr.status) = 'completed')::int AS completed_jobs
        FROM service_requests sr
        WHERE sr.requester_user_id = $1
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT ${requestListSelect},
          CASE WHEN sr.accepted_quotation_id IS NOT NULL THEN 1 ELSE 0 END::int AS quotation_count
        FROM service_requests sr
        WHERE sr.requester_user_id = $1
          AND (
            (sr.accepted_quotation_id IS NOT NULL AND LOWER(sr.status) IN ('open', 'pending'))
            OR (
              sr.moderation_status = 'approved'
              AND LOWER(sr.status) = 'open'
              AND sr.required_by IS NOT NULL
              AND sr.required_by <= CURRENT_DATE + INTERVAL '30 days'
            )
          )
        ORDER BY
          (sr.accepted_quotation_id IS NOT NULL) DESC,
          sr.required_by ASC NULLS LAST,
          sr.updated_at DESC
        LIMIT 8
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT ${requestListSelect}, e.full_name AS consultant_name
        FROM service_requests sr
        LEFT JOIN experts e ON e.id = sr.accepted_expert_id
        WHERE sr.requester_user_id = $1
          AND LOWER(sr.status) IN ('assigned', 'active')
        ORDER BY sr.required_by ASC NULLS LAST, sr.updated_at DESC
        LIMIT 8
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT ${requestListSelect}, e.full_name AS consultant_name
        FROM service_requests sr
        LEFT JOIN experts e ON e.id = sr.accepted_expert_id
        WHERE sr.requester_user_id = $1
          AND LOWER(sr.status) IN ('assigned', 'active')
          AND COALESCE(sr.required_by, sr.eta) >= CURRENT_DATE
        ORDER BY COALESCE(sr.required_by, sr.eta) ASC, sr.id DESC
        LIMIT 6
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT ${requestListSelect}
        FROM service_requests sr
        WHERE sr.requester_user_id = $1
        ORDER BY GREATEST(sr.created_at, sr.updated_at) DESC, sr.id DESC
        LIMIT 6
        `,
        [userId]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        kpis: summary.rows[0],
        attention_requests: attention.rows,
        active_jobs: activeJobs.rows,
        upcoming_inspections: upcoming.rows,
        recent_requests: recent.rows,
      },
    });
  } catch (error) {
    return sendDashboardError(res, "Client", error);
  }
};

const expertProfileCte = `
  WITH expert_profile AS (
    SELECT e.id, e.user_id, erd.discipline, erd.discipline_other
    FROM experts e
    LEFT JOIN expert_registration_details erd ON erd.expert_id = e.id
    WHERE e.user_id = $1
    LIMIT 1
  )
`;

const expertMatchSql = `
  EXISTS (
    SELECT 1 FROM expert_ports ep
    WHERE ep.expert_id = expert_profile.id
      AND LOWER(TRIM(ep.port_name)) = LOWER(TRIM(sr.port_name))
  )
  OR EXISTS (
    SELECT 1
    FROM expert_vessel_types evt
    JOIN master_vessel_types mvt ON mvt.id = evt.vessel_type_id
    WHERE evt.expert_id = expert_profile.id
      AND LOWER(TRIM(mvt.name)) = LOWER(TRIM(sr.vessel_type))
  )
  OR (
    COALESCE(expert_profile.discipline_other, expert_profile.discipline) IS NOT NULL
    AND (
      LOWER(COALESCE(sr.service_category, '')) LIKE '%' || LOWER(COALESCE(expert_profile.discipline_other, expert_profile.discipline)) || '%'
      OR LOWER(COALESCE(sr.service_type, '')) LIKE '%' || LOWER(COALESCE(expert_profile.discipline_other, expert_profile.discipline)) || '%'
    )
  )
  OR EXISTS (
    SELECT 1
    FROM expert_specialties es
    JOIN master_specialties ms ON ms.id = es.specialty_id
    WHERE es.expert_id = expert_profile.id
      AND (
        LOWER(COALESCE(sr.service_category, '')) LIKE '%' || LOWER(ms.name) || '%'
        OR LOWER(COALESCE(sr.service_type, '')) LIKE '%' || LOWER(ms.name) || '%'
      )
  )
`;

export const getExpertDashboard = async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const [summary, matching, assignments, quotations, upcoming] = await Promise.all([
      pool.query(
        `${expertProfileCte}
        SELECT
          (SELECT COUNT(*) FROM service_requests sr
            WHERE sr.moderation_status = 'approved'
              AND LOWER(sr.status) IN ('open', 'pending', 'active'))::int AS available_requests,
          (SELECT COUNT(*) FROM service_requests sr, expert_profile
            WHERE sr.moderation_status = 'approved'
              AND LOWER(sr.status) IN ('open', 'pending', 'active')
              AND (${expertMatchSql}))::int AS matching_requests,
          (SELECT COUNT(*) FROM quotations q
            WHERE q.expert_user_id = $1)::int AS quotes_submitted,
          (SELECT COUNT(*) FROM quotations q
            WHERE q.expert_user_id = $1 AND LOWER(q.status) IN ('submitted', 'pending'))::int AS quotes_pending,
          (SELECT COUNT(*) FROM quotations q
            WHERE q.expert_user_id = $1 AND LOWER(q.status) = 'accepted')::int AS quotes_accepted,
          (SELECT COUNT(*) FROM quotations q
            WHERE q.expert_user_id = $1 AND LOWER(q.status) = 'rejected')::int AS quotes_rejected,
          (SELECT COUNT(DISTINCT sr.id)
            FROM service_requests sr, expert_profile
            WHERE LOWER(sr.status) IN ('assigned', 'active')
              AND (sr.accepted_expert_id = expert_profile.id OR EXISTS (
                SELECT 1 FROM request_expert_assignments rea
                WHERE rea.service_request_id = sr.id AND rea.expert_id = expert_profile.id
              )))::int AS active_assignments,
          (SELECT COUNT(DISTINCT sr.id)
            FROM service_requests sr, expert_profile
            WHERE LOWER(sr.status) = 'completed'
              AND (sr.accepted_expert_id = expert_profile.id OR EXISTS (
                SELECT 1 FROM request_expert_assignments rea
                WHERE rea.service_request_id = sr.id AND rea.expert_id = expert_profile.id
              )))::int AS completed_jobs,
          COALESCE((SELECT SUM(
            COALESCE(q.total_quote_usd, 0) + COALESCE(q.travel_cost, 0)
            + COALESCE(q.accommodation_cost, 0) + COALESCE(q.report_fee, 0)
            + COALESCE(q.urgency_surcharge, 0)
          ) FROM quotations q
            WHERE q.expert_user_id = $1 AND LOWER(q.status) = 'accepted'), 0)::float
            AS accepted_quotation_value_usd
        `,
        [userId]
      ),
      pool.query(
        `${expertProfileCte}
        SELECT ${requestListSelect},
          CONCAT_WS(' + ',
            CASE WHEN EXISTS (SELECT 1 FROM expert_ports ep WHERE ep.expert_id = expert_profile.id AND LOWER(TRIM(ep.port_name)) = LOWER(TRIM(sr.port_name))) THEN 'Port' END,
            CASE WHEN EXISTS (SELECT 1 FROM expert_vessel_types evt JOIN master_vessel_types mvt ON mvt.id = evt.vessel_type_id WHERE evt.expert_id = expert_profile.id AND LOWER(TRIM(mvt.name)) = LOWER(TRIM(sr.vessel_type))) THEN 'Vessel type' END,
            CASE WHEN (
              (COALESCE(expert_profile.discipline_other, expert_profile.discipline) IS NOT NULL AND (
                LOWER(COALESCE(sr.service_category, '')) LIKE '%' || LOWER(COALESCE(expert_profile.discipline_other, expert_profile.discipline)) || '%'
                OR LOWER(COALESCE(sr.service_type, '')) LIKE '%' || LOWER(COALESCE(expert_profile.discipline_other, expert_profile.discipline)) || '%'
              )) OR EXISTS (SELECT 1 FROM expert_specialties es JOIN master_specialties ms ON ms.id = es.specialty_id WHERE es.expert_id = expert_profile.id AND (LOWER(COALESCE(sr.service_category, '')) LIKE '%' || LOWER(ms.name) || '%' OR LOWER(COALESCE(sr.service_type, '')) LIKE '%' || LOWER(ms.name) || '%'))
            ) THEN 'Discipline' END
          ) AS match_reason,
          CASE WHEN EXISTS (SELECT 1 FROM quotations q WHERE q.service_request_id = sr.id AND q.expert_user_id = $1) THEN 'submitted' ELSE 'not_submitted' END AS quotation_state
        FROM service_requests sr, expert_profile
        WHERE sr.moderation_status = 'approved'
          AND LOWER(sr.status) IN ('open', 'pending', 'active')
          AND (${expertMatchSql})
        ORDER BY sr.required_by ASC NULLS LAST, sr.created_at DESC
        LIMIT 8
        `,
        [userId]
      ),
      pool.query(
        `${expertProfileCte}
        SELECT ${requestListSelect}
        FROM service_requests sr, expert_profile
        WHERE LOWER(sr.status) IN ('assigned', 'active')
          AND (sr.accepted_expert_id = expert_profile.id OR EXISTS (
            SELECT 1 FROM request_expert_assignments rea
            WHERE rea.service_request_id = sr.id AND rea.expert_id = expert_profile.id
          ))
        ORDER BY sr.required_by ASC NULLS LAST, sr.updated_at DESC
        LIMIT 8
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT q.id, q.service_request_id, sr.title AS request_title,
          q.total_quote_usd, q.travel_cost, q.accommodation_cost, q.report_fee,
          q.urgency_surcharge, q.status, q.created_at, q.updated_at
        FROM quotations q
        JOIN service_requests sr ON sr.id = q.service_request_id
        WHERE q.expert_user_id = $1
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT 8
        `,
        [userId]
      ),
      pool.query(
        `${expertProfileCte}
        SELECT ${requestListSelect}
        FROM service_requests sr, expert_profile
        WHERE LOWER(sr.status) IN ('assigned', 'active')
          AND COALESCE(sr.required_by, sr.eta) >= CURRENT_DATE
          AND (sr.accepted_expert_id = expert_profile.id OR EXISTS (
            SELECT 1 FROM request_expert_assignments rea
            WHERE rea.service_request_id = sr.id AND rea.expert_id = expert_profile.id
          ))
        ORDER BY COALESCE(sr.required_by, sr.eta) ASC, sr.id DESC
        LIMIT 6
        `,
        [userId]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        kpis: summary.rows[0],
        matching_requests: matching.rows,
        active_assignments: assignments.rows,
        recent_quotations: quotations.rows,
        upcoming_work: upcoming.rows,
      },
    });
  } catch (error) {
    return sendDashboardError(res, "Expert", error);
  }
};

export const getAdminDashboard = async (_req, res) => {
  try {
    const [summary, moderations, quoteReview, activeJobs, registrations, recentQuotes, audit, workflowSummary, workflowRecent] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM users WHERE role_id = 3)::int AS total_clients,
          (SELECT COUNT(*) FROM experts)::int AS total_consultants,
          (SELECT COUNT(*) FROM experts WHERE availability = 'available')::int AS active_consultants,
          (SELECT COUNT(*) FROM service_requests)::int AS total_requests,
          (SELECT COUNT(*) FROM service_requests WHERE moderation_status = 'pending')::int AS pending_moderation_requests,
          (SELECT COUNT(*) FROM service_requests sr
            WHERE sr.moderation_status = 'approved' AND LOWER(sr.status) = 'open'
              AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.service_request_id = sr.id))::int AS requests_awaiting_quotes,
          (SELECT COUNT(*) FROM quotations q
            WHERE LOWER(q.status) IN ('submitted', 'pending'))::int AS quotes_awaiting_review,
          (SELECT COUNT(*) FROM service_requests WHERE LOWER(status) IN ('assigned', 'active'))::int AS active_jobs,
          (SELECT COUNT(*) FROM service_requests WHERE LOWER(status) = 'completed')::int AS completed_jobs,
          COALESCE((SELECT SUM(q.admin_markup_usd) FROM quotations q WHERE LOWER(q.status) = 'accepted'), 0)::float AS commission_value_usd
      `),
      pool.query(`
        SELECT ${requestListSelect}, u.full_name AS client_name
        FROM service_requests sr
        LEFT JOIN users u ON u.id = sr.requester_user_id
        WHERE sr.moderation_status = 'pending'
        ORDER BY sr.created_at ASC, sr.id ASC
        LIMIT 8
      `),
      pool.query(`
        SELECT q.id, q.service_request_id, sr.title AS request_title,
          e.full_name AS consultant_name, q.total_quote_usd, q.travel_cost,
          q.accommodation_cost, q.report_fee, q.urgency_surcharge,
          q.status, q.created_at
        FROM quotations q
        JOIN service_requests sr ON sr.id = q.service_request_id
        LEFT JOIN experts e ON e.id = q.expert_id
        WHERE LOWER(q.status) IN ('submitted', 'pending')
        ORDER BY q.created_at ASC, q.id ASC
        LIMIT 8
      `),
      pool.query(`
        SELECT ${requestListSelect}, u.full_name AS client_name,
          e.full_name AS consultant_name
        FROM service_requests sr
        LEFT JOIN users u ON u.id = sr.requester_user_id
        LEFT JOIN experts e ON e.id = sr.accepted_expert_id
        WHERE LOWER(sr.status) IN ('assigned', 'active')
        ORDER BY sr.required_by ASC NULLS LAST, sr.updated_at DESC
        LIMIT 8
      `),
      pool.query(`
        SELECT cp.id AS client_profile_id, u.id AS user_id, u.full_name,
          u.email, cp.verification_status, cp.verification_submitted_at,
          u.created_at
        FROM users u
        LEFT JOIN client_profiles cp ON cp.user_id = u.id
        WHERE u.role_id = 3
        ORDER BY COALESCE(cp.verification_submitted_at, u.created_at) DESC, u.id DESC
        LIMIT 6
      `),
      pool.query(`
        SELECT q.id, q.service_request_id, sr.title AS request_title,
          e.full_name AS consultant_name, q.total_quote_usd,
          q.admin_markup_usd, q.client_total_usd, q.status,
          q.created_at, q.updated_at
        FROM quotations q
        JOIN service_requests sr ON sr.id = q.service_request_id
        LEFT JOIN experts e ON e.id = q.expert_id
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT 6
      `),
      pool.query(`
        SELECT aal.id, aal.action, aal.target_type, aal.target_id,
          aal.summary, aal.reason, aal.created_at, u.full_name AS actor_name
        FROM public.admin_audit_logs aal
        LEFT JOIN users u ON u.id = aal.actor_user_id
        ORDER BY aal.created_at DESC, aal.id DESC
        LIMIT 8
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE iw.current_stage IN ('overview','quote','confirm'))::int AS awaiting_quotation_review,
          COUNT(*) FILTER (WHERE iw.current_stage IN ('preparation','checklist','report'))::int AS inspection_in_progress,
          COUNT(*) FILTER (WHERE iw.current_stage = 'review')::int AS report_awaiting_review,
          COUNT(*) FILTER (WHERE iw.current_stage = 'report_confirmation' AND ir.confirmed_at IS NULL)::int AS report_awaiting_confirmation,
          COUNT(*) FILTER (WHERE iw.current_stage = 'report_confirmation' AND ir.confirmed_at IS NOT NULL)::int AS inspection_awaiting_completion,
          COUNT(*) FILTER (WHERE iw.current_stage = 'invoice_submitted')::int AS invoice_approval_required,
          COUNT(*) FILTER (WHERE iw.current_stage = 'invoice_approved')::int AS payment_pending,
          COUNT(*) FILTER (WHERE iw.current_stage = 'invoice_paid')::int AS completed_workflows
        FROM inspection_workflows iw
        LEFT JOIN inspection_reports ir ON ir.id=iw.report_id
      `),
      pool.query(`
        SELECT iw.id, iw.id AS workflow_id, iw.service_request_id, iw.current_stage,
          sr.title AS request_title, sr.vessel_name, sr.required_by
        FROM inspection_workflows iw
        JOIN service_requests sr ON sr.id=iw.service_request_id
        LEFT JOIN inspection_reports ir ON ir.id=iw.report_id
        WHERE iw.current_stage NOT IN ('invoice_paid')
        ORDER BY
          CASE
            WHEN iw.current_stage IN ('invoice_submitted','invoice_approved') THEN 1
            WHEN iw.current_stage IN ('review','report_confirmation') THEN 2
            WHEN iw.current_stage IN ('preparation','checklist','report') THEN 3
            ELSE 4
          END,
          sr.required_by ASC NULLS LAST, iw.updated_at ASC
        LIMIT 8
      `),
    ]);

    return res.json({
      success: true,
      data: {
        kpis: summary.rows[0],
        pending_moderations: moderations.rows,
        quotes_for_review: quoteReview.rows,
        active_jobs: activeJobs.rows,
        recent_registrations: registrations.rows,
        recent_quotations: recentQuotes.rows,
        recent_audit_activity: audit.rows,
        inspection_workflow: {
          ...workflowSummary.rows[0],
          recent: workflowRecent.rows,
        },
      },
    });
  } catch (error) {
    return sendDashboardError(res, "Admin", error);
  }
};

export const getProviderDashboard = async (req, res) => {
  try {
    const userId = Number(req.user.id);

    /* Resolve the company account and entity owned by this user */
    const accountResult = await pool.query(
      `SELECT mca.entity_id, mca.primary_type
       FROM public.maritime_company_accounts mca
       WHERE mca.user_id = $1`,
      [userId]
    );
    const account = accountResult.rows[0];
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "No company profile is linked to this account.",
      });
    }
    const entityId = account.entity_id;

    const [
      entityResult,
      typesResult,
      summaryResult,
      servicesResult,
      portsResult,
      branchesResult,
      productsResult,
      certificationsResult,
      classApprovalsResult,
      membershipsResult,
      faqCountResult,
    ] = await Promise.all([
      pool.query(
        `SELECT id, company_name, slug, description, country, city,
           public_address, public_email, public_phone, website,
           logo_url, logo_s3_key, review_status, is_active,
           years_experience, vessels_handled, created_at
         FROM public.maritime_directory_entities
         WHERE id = $1`,
        [entityId]
      ),
      pool.query(
        `SELECT directory_type
         FROM public.maritime_directory_entity_types
         WHERE entity_id = $1
         ORDER BY directory_type`,
        [entityId]
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM public.maritime_directory_services WHERE entity_id = $1) AS services,
           (SELECT COUNT(*)::int FROM public.maritime_directory_ports WHERE entity_id = $1) AS ports,
           (SELECT COUNT(*)::int FROM public.maritime_directory_branches WHERE entity_id = $1) AS branches,
           (SELECT COUNT(*)::int FROM public.maritime_directory_products WHERE entity_id = $1) AS products,
           (SELECT COUNT(*)::int FROM public.maritime_directory_certifications WHERE entity_id = $1) AS certifications,
           (SELECT COUNT(*)::int FROM public.maritime_directory_class_approvals WHERE entity_id = $1) AS class_approvals,
           (SELECT COUNT(*)::int FROM public.maritime_directory_memberships WHERE entity_id = $1) AS memberships,
           (SELECT COUNT(*)::int FROM public.maritime_directory_faqs WHERE entity_id = $1) AS faqs`,
        [entityId]
      ),
      pool.query(
        `SELECT id, service_name, category, service_type
         FROM public.maritime_directory_services
         WHERE entity_id = $1
         ORDER BY created_at, id
         LIMIT 10`,
        [entityId]
      ),
      pool.query(
        `SELECT id, port_name, country
         FROM public.maritime_directory_ports
         WHERE entity_id = $1
         ORDER BY created_at, id
         LIMIT 10`,
        [entityId]
      ),
      pool.query(
        `SELECT id, branch_name, branch_type, city, country, public_telephone, public_email
         FROM public.maritime_directory_branches
         WHERE entity_id = $1
         ORDER BY created_at, id
         LIMIT 8`,
        [entityId]
      ),
      pool.query(
        `SELECT id, product_name, category, manufacturer
         FROM public.maritime_directory_products
         WHERE entity_id = $1
         ORDER BY created_at, id
         LIMIT 8`,
        [entityId]
      ),
      pool.query(
        `SELECT id, certification_name, standard_code, issuer, expiry_date
         FROM public.maritime_directory_certifications
         WHERE entity_id = $1
         ORDER BY created_at, id
         LIMIT 8`,
        [entityId]
      ),
      pool.query(
        `SELECT id, society_name, approval_details
         FROM public.maritime_directory_class_approvals
         WHERE entity_id = $1
         ORDER BY created_at, id
         LIMIT 8`,
        [entityId]
      ),
      pool.query(
        `SELECT id, organization_name, membership_details
         FROM public.maritime_directory_memberships
         WHERE entity_id = $1
         ORDER BY created_at, id
         LIMIT 8`,
        [entityId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM public.maritime_directory_faqs
         WHERE entity_id = $1`,
        [entityId]
      ),
    ]);

    const entity = entityResult.rows[0];
    if (!entity) {
      return res.status(404).json({
        success: false,
        message: "Company directory entry not found.",
      });
    }

    const types = typesResult.rows.map((r) => r.directory_type);
    const counts = summaryResult.rows[0];
    const isSupplier = types.includes("supplier");

    /* ---- Profile completeness ---- */
    const sections = [];
    const completed = [];

    const check = (label, condition) => {
      sections.push(label);
      if (condition) completed.push(label);
    };

    check("Company name", !!entity.company_name);
    check("Contact information", !!(entity.public_email || entity.public_phone));
    check("Company description", !!entity.description);
    check("Company type", types.length > 0);
    check("Services", counts.services > 0);
    check("Ports covered", counts.ports > 0);
    check("Branches", counts.branches > 0);
    check("Company logo", !!(entity.logo_url || entity.logo_s3_key));
    if (isSupplier) check("Products", counts.products > 0);

    const missing = sections.filter((s) => !completed.includes(s));
    const totalSections = sections.length;
    const completedCount = completed.length;

    /* Strip the S3 key from the response */
    const { logo_s3_key, ...safeEntity } = entity;

    return res.json({
      success: true,
      data: {
        company: {
          ...safeEntity,
          types,
        },
        summary: counts,
        profile_setup: {
          completed_sections: completedCount,
          total_sections: totalSections,
          percentage: totalSections ? Math.round((completedCount / totalSections) * 100) : 0,
          missing,
        },
        services: servicesResult.rows,
        ports: portsResult.rows,
        branches: branchesResult.rows,
        products: isSupplier ? productsResult.rows : [],
        credentials: {
          certifications: certificationsResult.rows,
          class_approvals: classApprovalsResult.rows,
          memberships: membershipsResult.rows,
        },
        faqs_count: faqCountResult.rows[0].total,
      },
    });
  } catch (error) {
    return sendDashboardError(res, "Provider", error);
  }
};

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

    const [totalRequests, openRequests, verifiedExperts, vesselsRegistered, requestsByServiceType, urgencyDistribution, financialOverview, topRatedExperts] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM service_requests ${requestWhere}`, requestValues),
      pool.query(`SELECT COUNT(*)::int AS total FROM service_requests ${requestWhere ? `${requestWhere} AND` : "WHERE"} LOWER(status) IN ('open', 'pending', 'active')`, requestValues),
      pool.query(`SELECT COUNT(*)::int AS total FROM experts WHERE availability = 'available'`),
      pool.query(`SELECT COUNT(*)::int AS total FROM vessels ${vesselWhere}`, vesselValues),
      pool.query(`SELECT service_type, COUNT(*)::int AS count FROM service_requests ${requestWhere} GROUP BY service_type ORDER BY count DESC`, requestValues),
      roleId === 2 ? Promise.resolve({ rows: [] }) : pool.query(`SELECT urgency, COUNT(*)::int AS count FROM service_requests ${requestWhere} GROUP BY urgency ORDER BY count DESC`, requestValues),
      roleId === 2 ? Promise.resolve({ rows: [{ avg_budget_per_request: 0, completed_requests: 0 }] }) : pool.query(`SELECT COALESCE(ROUND(AVG(budget_usd), 2), 0)::float AS avg_budget_per_request, COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_requests FROM service_requests ${requestWhere}`, requestValues),
      pool.query(`SELECT id, full_name, base_location, country, is_premium, rating, review_count FROM experts ORDER BY rating DESC, review_count DESC LIMIT 5`),
    ]);

    return res.json({
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
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard stats",
      error: error.message,
    });
  }
};
