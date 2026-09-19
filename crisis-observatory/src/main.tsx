import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./global.css";
import ControlCenter from "./ui/ControlCenter";

createRoot(document.getElementById("root")!).render(
  <StrictMode><ControlCenter /></StrictMode>,
);
