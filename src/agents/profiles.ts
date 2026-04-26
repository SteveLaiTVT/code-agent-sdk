import type { AgentRole, NetworkPermission, RolePermissionProfile } from "../core/types.js";

export const noNetwork: NetworkPermission = {
  shellNetwork: false,
  webSearch: false,
  mcpRead: false,
  mcpWrite: false,
};

export const ROLE_PERMISSION_PROFILES: Record<AgentRole, RolePermissionProfile> = {
  planner: {
    role: "planner",
    modelTier: "gpt-5.5",
    reasoningEffort: "xhigh",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    canWriteProjectRoot: false,
    defaultNetwork: {
      shellNetwork: false,
      webSearch: true,
      mcpRead: true,
      mcpWrite: false,
    },
  },
  "component-worker": {
    role: "component-worker",
    modelTier: "spark",
    reasoningEffort: "low",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    canWriteProjectRoot: false,
    defaultNetwork: { ...noNetwork },
  },
  "layout-worker": {
    role: "layout-worker",
    modelTier: "mini",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    canWriteProjectRoot: false,
    defaultNetwork: { ...noNetwork },
  },
  "screen-worker": {
    role: "screen-worker",
    modelTier: "gpt-5.5",
    reasoningEffort: "high",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    canWriteProjectRoot: false,
    defaultNetwork: { ...noNetwork },
  },
  reviewer: {
    role: "reviewer",
    modelTier: "gpt-5.5",
    reasoningEffort: "xhigh",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    canWriteProjectRoot: false,
    defaultNetwork: {
      shellNetwork: false,
      webSearch: true,
      mcpRead: true,
      mcpWrite: false,
    },
  },
  verifier: {
    role: "verifier",
    modelTier: "program",
    reasoningEffort: "none",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    canWriteProjectRoot: false,
    defaultNetwork: { ...noNetwork },
  },
  "merge-broker": {
    role: "merge-broker",
    modelTier: "program",
    reasoningEffort: "none",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    canWriteProjectRoot: false,
    defaultNetwork: { ...noNetwork },
  },
};

export function getRolePermissionProfile(role: AgentRole): RolePermissionProfile {
  return ROLE_PERMISSION_PROFILES[role];
}

export function mergeNetworkPermission(
  base: NetworkPermission,
  override?: Partial<NetworkPermission>
): NetworkPermission {
  return {
    shellNetwork: override?.shellNetwork ?? base.shellNetwork,
    webSearch: override?.webSearch ?? base.webSearch,
    mcpRead: override?.mcpRead ?? base.mcpRead,
    mcpWrite: override?.mcpWrite ?? base.mcpWrite,
  };
}
