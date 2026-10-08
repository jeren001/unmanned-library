import { Router } from "express";

export function createPublicRouter(getStats: () => Record<string, unknown>) {
  const router = Router();

  router.get("/stats", (_req, res) => {
    const overview = getStats();
    res.json({
      branchesLive: overview.branches ?? 0,
      devicesOnline: overview.devicesOnline ?? 0,
      loansToday: overview.loansToday ?? 0,
      branchNetwork: "connected",
      version: "v0.1.0"
    });
  });

  return router;
}
