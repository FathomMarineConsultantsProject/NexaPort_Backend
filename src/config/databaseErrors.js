const unavailableCodes = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "53300", "53400", "57P01", "57P02", "57P03", "57014",
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
]);

export const isDatabaseUnavailable = (error) =>
  unavailableCodes.has(error?.code) ||
  /timeout exceeded when trying to connect|connection terminated|query read timeout/i.test(error?.message || "");

export const logDatabaseError = (context, error) => {
  // PostgreSQL error messages may contain SQL, hostnames or user input.
  console.error(context, { code: error?.code || "UNKNOWN", kind: isDatabaseUnavailable(error) ? "unavailable" : "request_error" });
};
