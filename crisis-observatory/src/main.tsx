import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./global.css";
import ControlCenter from "./ui/ControlCenter";
import EscalationPoliciesPage from "./ui/evidence/EscalationPoliciesPage";
import CoordinationPoliciesPage from "./ui/evidence/CoordinationPoliciesPage";

let route = window.location.pathname.replace(/\/$/, "");
if (route === "/policies") {
  // Preserve old doctrine citations without sending them to the editable escalation catalog.
  route = window.location.hash ? "/coordination-policies" : "/escalation-policies";
  window.history.replaceState(null, "", route + window.location.search + window.location.hash);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{route === "/escalation-policies" ? <EscalationPoliciesPage /> : route === "/coordination-policies" ? <CoordinationPoliciesPage /> : <ControlCenter />}</StrictMode>,
);
