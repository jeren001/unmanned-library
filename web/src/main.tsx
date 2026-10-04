import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import "./styles.css";

const routes = createBrowserRouter([
  { path: "/", element: <Navigate to="/login" replace /> },
  { path: "/login", element: <Placeholder title="Login" /> },
  { path: "/kiosk", element: <Placeholder title="Kiosk" /> },
  { path: "/admin", element: <Placeholder title="Admin" /> },
  { path: "/admin/wallboard", element: <Placeholder title="Wallboard" /> }
]);

function Placeholder({ title }: { title: string }) {
  return <main>{title}</main>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={routes} />
  </React.StrictMode>
);
