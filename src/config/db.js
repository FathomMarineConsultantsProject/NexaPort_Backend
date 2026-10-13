import pg from "pg";
import dotenv from "dotenv";
import { logDatabaseError } from "./databaseErrors.js";

dotenv.config();

const { Pool, types } = pg;

// Return PostgreSQL DATE (OID 1082) as plain YYYY-MM-DD string without timezone conversion
types.setTypeParser(1082, (val) => val);

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 15000,
});

// Idle-client failures are emitted by pg.Pool outside an active request.
pool.on("error", (error) => logDatabaseError("PostgreSQL idle client error", error));
