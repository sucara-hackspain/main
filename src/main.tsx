import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import BackendV2 from "./backend/BackendV2";

createRoot(document.getElementById("root")!).render(
  <StrictMode><BackendV2 /></StrictMode>,
);
