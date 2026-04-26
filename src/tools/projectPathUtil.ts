import path from "node:path";

function assertInsideProject(projectRoot: string, targetPath: string): string {
    const root = path.resolve(projectRoot);
    const target = path.resolve(projectRoot, targetPath);

    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Path escapes project root: ${target}`);
    }

    return target;
}

export function resolveInsideProject(projectRoot: string, relativePaths: string[] = []): string[] {
    return relativePaths.map((p) => assertInsideProject(projectRoot, p));
}

