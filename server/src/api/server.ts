import express from "express";
import { healthRouter } from "./health.js";

export function createServer() {
  const app = express();

  app.use(express.json());
  app.use("/api/health", healthRouter);

  return app;
}
