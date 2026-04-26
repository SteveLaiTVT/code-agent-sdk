import { getRolePermissionProfile, mergeNetworkPermission } from "./profiles.js";
import { resolveInsideProject } from "../core/path-safety.js";
import type {
  AgentRole,
  NetworkPermission,
  ProjectSpace,
  SandboxMode,
  TaskScope,
} from "../core/types.js";

export interface OrchestrationCodexOptions {
  config: {
    sandbox_mode: SandboxMode;
    approval_policy: "never" | "on-request" | "untrusted";
    show_raw_agent_reasoning: boolean;
    sandbox_workspace_write: {
      network_access: boolean;
      writable_roots: string[];
      exclude_slash_tmp: true;
      exclude_tmpdir_env_var: true;
    };
    shell_environment_policy: {
      inherit: "core";
      ignore_default_excludes: false;
      include_only: string[];
      exclude: string[];
    };
    history: {
      persistence: "none";
    };
  };
  toolPermissions: {
    webSearch: boolean;
    mcpRead: boolean;
    mcpWrite: boolean;
  };
}

export interface CreateCodexOptionsInput {
  role: AgentRole;
  project: ProjectSpace;
  taskScope?: TaskScope;
  showRawReasoning?: boolean;
}

const SECRET_ENV_EXCLUDES = [
  "*SECRET*",
  "*TOKEN*",
  "*KEY*",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "AWS_*",
  "AZURE_*",
  "DATABASE_URL",
];

function defaultWritablePathsForRole(role: AgentRole): string[] {
  switch (role) {
    case "reviewer":
      return [".agent-orchestrator/reviews", ".agent-orchestrator/tmp"];
    case "verifier":
      return [".agent-orchestrator/verification", ".agent-orchestrator/tmp", "coverage"];
    case "merge-broker":
      return [".agent-orchestrator/merge", ".agent-orchestrator/tmp"];
    case "planner":
    case "component-worker":
    case "layout-worker":
    case "screen-worker":
      return [];
  }
}

function getWritableRoots(role: AgentRole, project: ProjectSpace, taskScope?: TaskScope): string[] {
  const profile = getRolePermissionProfile(role);

  if (profile.canWriteProjectRoot) {
    return [resolveInsideProject(project.root, ".")];
  }

  const scopedWritablePaths = [
    ...(taskScope?.writablePaths ?? []),
    ...(taskScope?.reportPaths ?? []),
  ];

  const roleDefaults = scopedWritablePaths.length === 0 ? defaultWritablePathsForRole(role) : [];
  return [...scopedWritablePaths, ...roleDefaults].map((targetPath) =>
    resolveInsideProject(project.root, targetPath)
  );
}

function getSandboxMode(profileSandboxMode: SandboxMode, writableRoots: string[]): SandboxMode {
  if (writableRoots.length > 0) {
    return "workspace-write";
  }
  return profileSandboxMode;
}

function getNetwork(role: AgentRole, taskScope?: TaskScope): NetworkPermission {
  const profile = getRolePermissionProfile(role);
  return mergeNetworkPermission(profile.defaultNetwork, taskScope?.network);
}

export function createCodexOptions(input: CreateCodexOptionsInput): OrchestrationCodexOptions {
  const { role, project, taskScope, showRawReasoning = false } = input;
  const profile = getRolePermissionProfile(role);
  const writableRoots = getWritableRoots(role, project, taskScope);
  const network = getNetwork(role, taskScope);

  return {
    config: {
      sandbox_mode: getSandboxMode(profile.sandboxMode, writableRoots),
      approval_policy: profile.approvalPolicy,
      show_raw_agent_reasoning: showRawReasoning,
      sandbox_workspace_write: {
        network_access: network.shellNetwork,
        writable_roots: writableRoots,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
      shell_environment_policy: {
        inherit: "core",
        ignore_default_excludes: false,
        include_only: ["PATH", "HOME", "NODE_ENV", "CI"],
        exclude: SECRET_ENV_EXCLUDES,
      },
      history: {
        persistence: "none",
      },
    },
    toolPermissions: {
      webSearch: network.webSearch,
      mcpRead: network.mcpRead,
      mcpWrite: network.mcpWrite,
    },
  };
}
