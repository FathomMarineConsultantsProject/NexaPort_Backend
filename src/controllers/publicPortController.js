import { pool } from "../config/db.js";

const MIN_SEARCH_LENGTH = 2;
const MAX_RESULTS = 50;

const normalizeSearch = (value) => String(value || "").trim().replace(/\s+/g, " ");

export const buildPublicPortSearchQuery = ({ search, limit } = {}) => {
  const normalizedSearch = normalizeSearch(search);
  if (normalizedSearch.length < MIN_SEARCH_LENGTH) {
    return { error: `Search must contain at least ${MIN_SEARCH_LENGTH} characters` };
  }

  const parsedLimit = Number.parseInt(limit, 10);
  const boundedLimit = Math.min(
    MAX_RESULTS,
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : MAX_RESULTS)
  );

  return {
    text: `
      SELECT p.id, p.port_name, p.country, p.region, p.unlocode
      FROM ports p
      WHERE p.is_active = true
        AND (
          p.port_name ILIKE '%' || $1 || '%'
          OR p.country ILIKE '%' || $1 || '%'
          OR p.unlocode ILIKE '%' || $1 || '%'
        )
      ORDER BY p.port_name, p.id
      LIMIT $2
    `,
    values: [normalizedSearch, boundedLimit],
  };
};

export const createPublicPortSearchHandler = ({ query = (text, values) => pool.query(text, values) } = {}) =>
  async (req, res) => {
    const searchQuery = buildPublicPortSearchQuery(req.query);
    if (searchQuery.error) {
      return res.status(400).json({ success: false, message: searchQuery.error });
    }

    try {
      const result = await query(searchQuery.text, searchQuery.values);
      const ports = result.rows.map(({ id, port_name, country, region, unlocode }) => ({
        id,
        port_name,
        country,
        region,
        unlocode,
      }));
      return res.json({ success: true, ports });
    } catch (error) {
      console.error("Public port search failed", { code: String(error?.code || "UNKNOWN") });
      return res.status(500).json({ success: false, message: "Unable to search ports" });
    }
  };

export const searchPublicPorts = createPublicPortSearchHandler();
