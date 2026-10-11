import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { LoginPage } from "./login/LoginPage";
import { KioskPage } from "./kiosk/KioskPage";
import { AdminPage } from "./admin/AdminPage";
import "./shared/i18n";
import { DesignPage } from "./shared/DesignPage";
import "./styles.css";
import "./shared/components.css";

const routes = createBrowserRouter([
  { path: "/", element: <Navigate to="/login" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/kiosk", element: <KioskPage /> },
  { path: "/admin/*", element: <AdminPage /> },
  { path: "/design", element: <DesignPage /> }
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={routes} />
  </React.StrictMode>
);
