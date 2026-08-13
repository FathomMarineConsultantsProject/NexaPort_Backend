import dotenv from "dotenv";

dotenv.config();

const requiredRuntimeVariables = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "JWT_SECRET",
];

if (process.env.NODE_ENV !== "production") {
  const missing = requiredRuntimeVariables.filter((name) => !process.env[name]);
  if (missing.length) console.warn(`Missing required environment variables: ${missing.join(", ")}`);
}

const { default: app } = await import("./app.js");
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
