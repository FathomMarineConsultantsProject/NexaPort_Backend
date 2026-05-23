import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import testRoutes from "./routes/testRoutes.js";
import expertRoutes from "./routes/expertRoutes.js";
import masterRoutes from "./routes/masterRoutes.js";

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

//Main APIs
app.use("/api/experts", expertRoutes);
app.use("/api/master", masterRoutes);

export default app;