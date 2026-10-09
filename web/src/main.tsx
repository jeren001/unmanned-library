import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import "@fontsource/fraunces/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-serif-sc/600.css";
import { LoginPage } from "./login/LoginPage";
import { KioskPage } from "./kiosk/KioskPage";
import { AdminPage } from "./admin/AdminPage";
import "./shared/i18n";
import { ShowcasePage } from "./shared/components";
import "./shared/components.css";
import "./styles.css";

const routes = createBrowserRouter([
  { path: "/", element: <Navigate to="/login" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/kiosk", element: <KioskPage /> },
  { path: "/admin/*", element: <AdminPage /> },
  { path: "/design", element: <ShowcasePage /> }
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={routes} />
  </React.StrictMode>
);
