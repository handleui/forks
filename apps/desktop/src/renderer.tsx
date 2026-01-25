import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app.js";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}
createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
