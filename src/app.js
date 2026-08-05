//app.js - Main application file for NexaPort Backend API

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import testRoutes from "./routes/testRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import expertRoutes from "./routes/expertRoutes.js";
import masterRoutes from "./routes/masterRoutes.js";
import vesselRoutes from "./routes/vesselRoutes.js";
import portRoutes from "./routes/portRoutes.js";
import serviceRequestRoutes from "./routes/serviceRequestRoutes.js";
import quotationRoutes from "./routes/quotationRoutes.js";
import expertReviewRoutes from "./routes/expertReviewRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import clientOnboardingRoutes from "./routes/clientOnboardingRoutes.js";
import adminClientRegistrationRoutes from "./routes/adminClientRegistrationRoutes.js";
import adminNotificationRoutes from "./routes/adminNotificationRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import adminAdministrationRoutes from "./routes/adminAdministrationRoutes.js";
import flagRoutes from "./routes/flagRoutes.js";
import appointedSurveyorRoutes from "./routes/appointedSurveyorRoutes.js";
import publicStatsRoutes from "./routes/publicStatsRoutes.js";
import maritimeDirectoryRoutes from "./routes/maritimeDirectoryRoutes.js";
import maritimeCompanyRoutes from "./routes/maritimeCompanyRoutes.js";
import templateRoutes from "./routes/templateRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import {
  accreditationSchemeRouter,
  accreditedInspectorRouter,
} from "./routes/accreditedInspectorRoutes.js";

const app = express();

export const normalizeCorsOrigin = (origin) =>
  origin?.trim().replace(/\/+$/, "");

export const allowedCorsOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:5174",
  "https://nexa-port-frontend.vercel.app",
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ALLOWED_ORIGINS || "").split(","),
].map(normalizeCorsOrigin).filter(Boolean));
export const corsOptions = {
  origin(origin, callback) { callback(null, !origin || allowedCorsOrigins.has(normalizeCorsOrigin(origin))); },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "NexaPort Backend API running",
  });
});

app.get("/health", (req, res) => {
  res.json({ success: true, status: "OK" });
});
app.use("/api", testRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/public", publicStatsRoutes);

//Main APIs
app.use("/api/users", userRoutes);
app.use("/api/client-onboarding", clientOnboardingRoutes);
app.use("/api/admin/client-registrations", adminClientRegistrationRoutes);
app.use("/api/admin/maritime-directory", maritimeDirectoryRoutes);
app.use("/api/company", maritimeCompanyRoutes);
app.use("/api/admin-notifications", adminNotificationRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminAdministrationRoutes);
app.use("/api/experts", expertRoutes);
app.use("/api/master", masterRoutes);
app.use("/api/vessels", vesselRoutes);
app.use("/api/ports", portRoutes);
app.use("/api/flags", flagRoutes);
app.use("/api/accreditation-schemes", accreditationSchemeRouter);
app.use("/api/accredited-inspectors", accreditedInspectorRouter);
app.use("/api/appointed-surveyors", appointedSurveyorRoutes);
app.use("/api/service-requests", serviceRequestRoutes);
app.use("/api/quotations", quotationRoutes);
app.use("/api/experts", expertReviewRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/reports", reportRoutes);

export default app;
