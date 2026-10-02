import { pool } from "../config/db.js";
import { generateScope, resolveScopeInput } from "../services/scopeGenerationService.js";

export function createScopeGenerationController({ queryable = pool, generate = generateScope, now = Date.now, limit = 10, windowMs = 3600000, logError = console.error } = {}) {
  const usage = new Map();
  return async (req, res) => {
    const time = now(), key = String(req.user.id);
    for (const [userId, entry] of usage) if (entry.resetAt <= time) usage.delete(userId);
    const entry = usage.get(key) || { count: 0, resetAt: time + windowMs };
    if (entry.count >= limit) return res.status(429).json({ success: false, code: "AI_SCOPE_RATE_LIMITED", message: "Scope generation limit reached. Please try again later." });
    entry.count += 1;
    usage.set(key, entry);
    try {
      const context = await resolveScopeInput(req.body, queryable);
      return res.json({ success: true, ...(await generate(context)) });
    } catch (error) {
      const safe = error.safe && [400, 429, 502, 503, 504].includes(error.status);
      logError("AI scope generation failed", { code: safe ? error.code : "SCOPE_GENERATION_UNAVAILABLE", status: safe ? error.status : 503, ...(Number.isInteger(error.providerStatus) ? { providerStatus: error.providerStatus } : {}) });
      return res.status(safe ? error.status : 503).json({ success: false, code: safe ? error.code : "SCOPE_GENERATION_UNAVAILABLE", message: safe ? error.message : "Scope generation is temporarily unavailable. Please try again later." });
    }
  };
}
export const generateRequestScope = createScopeGenerationController();
