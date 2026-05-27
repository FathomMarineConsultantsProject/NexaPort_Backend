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

const app = express();

app.use(cors());
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

//Main APIs
app.use("/api/experts", expertRoutes);
app.use("/api/master", masterRoutes);
app.use("/api/vessels", vesselRoutes);
app.use("/api/ports", portRoutes);
app.use("/api/service-requests", serviceRequestRoutes);
app.use("/api/quotations", quotationRoutes);
app.use("/api/experts", expertReviewRoutes);
app.use("/api/dashboard", dashboardRoutes);

export default app;