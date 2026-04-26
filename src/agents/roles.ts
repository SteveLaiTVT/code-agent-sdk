import type { AgentRole } from "../core/types.js";

export const AGENT_ROLES: readonly AgentRole[] = [
  "planner",
  "component-worker",
  "layout-worker",
  "screen-worker",
  "reviewer",
  "verifier",
  "merge-broker",
] as const;

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

export function isImplementationRole(role: AgentRole): boolean {
  return role === "component-worker" || role === "layout-worker" || role === "screen-worker";
}
