import path from "node:path";
import {resolveInsideProject} from "../tools/projectPathUtil.js";
import {CodexOptions} from "@openai/codex-sdk";

type AgentRole =
    | "main-coding"
    | "sub-detail"
    | "chunk-checker"
    | "reviewer"
    | "planner";

interface ProjectSpace {
    projectId: string;
    root: string;
}

interface TaskScope {
    readablePaths?: string[];
    writablePaths?: string[];
    reportPaths?: string[];
    allowNetwork?: boolean;
}

type ApprovalPolicy = "never" | "on-request" | "untrusted";
type SandboxMode = "read-only" | "workspace-write";

interface RolePermissionProfile {
    sandboxMode: SandboxMode;
    approvalPolicy: ApprovalPolicy;
    defaultNetworkAccess: boolean;
    canWriteProjectRoot: boolean;
}

const rolePermissionProfiles: Record<AgentRole, RolePermissionProfile> = {
    "main-coding": {
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        defaultNetworkAccess: true,
        canWriteProjectRoot: true,
    },

    "sub-detail": {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        defaultNetworkAccess: false,
        canWriteProjectRoot: false,
    },

    "chunk-checker": {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        defaultNetworkAccess: false,
        canWriteProjectRoot: false,
    },

    "reviewer": {
        sandboxMode: "read-only",
        approvalPolicy: "never",
        defaultNetworkAccess: true,
        canWriteProjectRoot: false,
    },

    "planner": {
        sandboxMode: "read-only",
        approvalPolicy: "never",
        defaultNetworkAccess: true,
        canWriteProjectRoot: false,
    },
};

function getWritableRoots(
    project: ProjectSpace,
    role: AgentRole,
    taskScope?: TaskScope
): string[] {
    const profile = rolePermissionProfiles[role];

    if (profile.sandboxMode === "read-only") {
        return [];
    }

    if (profile.canWriteProjectRoot) {
        return [path.resolve(project.root)];
    }

    const writablePaths = [
        ...(taskScope?.writablePaths ?? []),
        ...(taskScope?.reportPaths ?? []),
    ];

    return resolveInsideProject(project.root, writablePaths);
}

interface CreateCodexOptionsInput {
    role: AgentRole;
    project: ProjectSpace;
    taskScope?: TaskScope;
    showRawReasoning?: boolean;
}

function createCodexOptions(input: CreateCodexOptionsInput): CodexOptions {
    const { role, project, taskScope, showRawReasoning = false } = input;

    const profile = rolePermissionProfiles[role];
    const writableRoots = getWritableRoots(project, role, taskScope);

    const networkAccess =
        taskScope?.allowNetwork ?? profile.defaultNetworkAccess;

    return {
        config: {
            sandbox_mode:
                writableRoots.length > 0 ? "workspace-write" : profile.sandboxMode,

            approval_policy: profile.approvalPolicy,

            show_raw_agent_reasoning: showRawReasoning,

            sandbox_workspace_write: {
                network_access: networkAccess,
                writable_roots: writableRoots,
                exclude_slash_tmp: true,
                exclude_tmpdir_env_var: true,
            },

            shell_environment_policy: {
                inherit: "core",
                ignore_default_excludes: false,
                include_only: ["PATH", "HOME", "NODE_ENV", "CI"],
                exclude: [
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
                ],
            },

            history: {
                persistence: "none",
            },
        },
    };
}