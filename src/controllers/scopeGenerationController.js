import { pool } from "../config/db.js";
import { generateScope, resolveScopeInput } from "../services/scopeGenerationService.js";

export function createScopeGenerationController({ queryable = pool, generate = generateScope, now = Date.now, limit = 10, windowMs = 3600000 } = {}) {
  const usage = new Map();
  return async (req, res) => {
    const time = now(), key = String(req.user.id);
    for (const [userId, entry] of usage) if (entry.resetAt <= time) usage.delete(userId);
    const entry = usage.get(key) || { count: 0, resetAt: time + windowMs };
    if (entry.count >= limit) return res.status(429).json({ success: false, message: "Scope generation limit reached. Please try again later." });
    entry.count += 1;
    usage.set(key, entry);
    try {
      const context = await resolveScopeInput(req.body, queryable);
      return res.json(await generate(context));
    } catch (error) {
      const safe = [400, 429, 502, 503].includes(error.status);
      return res.status(safe ? error.status : 503).json({ success: false, message: safe ? error.message : "Scope generation is temporarily unavailable. Please try again later." });
    }
  };
}
export const generateRequestScope = createScopeGenerationController();
