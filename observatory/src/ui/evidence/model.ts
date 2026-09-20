import type { TicketStep } from "../tickets/model";
export type Evidence = { id: string; label: string; title: string; href: string };
export function policyHref(id: string): string {
  const template = import.meta.env.VITE_POLICY_URL_TEMPLATE as string | undefined;
  if (template) {
    const candidate = template.includes("{id}") ? template.replaceAll("{id}", encodeURIComponent(id)) : template + "#" + encodeURIComponent(id);
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch { /* Use local reference if the published URL is invalid. */ }
  }
  return "/coordination-policies#" + encodeURIComponent(id);
}
export function stepReferences(step: TicketStep): Evidence[] {
  return [...new Set(step.applies ?? [])].map((id) => ({
    id, label: id, title: `Política de coordinación ${id}`, href: policyHref(id),
  }));
}
