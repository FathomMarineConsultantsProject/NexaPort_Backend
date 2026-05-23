import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

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

export default app;