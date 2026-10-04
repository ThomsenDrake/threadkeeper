export type LearnedSource = { commit: string; tree: string; files: Record<string, string> };
export type LearnedInstallation = { loader: string; evidence: { package_manager: string; installation: string; lockfile_sha256: string; typescript_loader: string } };
export function archiveLearnedSource(root: string, destination: string): Promise<LearnedSource>;
export function installLearnedDependencies(snapshotRoot: string, signal: AbortSignal, cacheContext?: string): Promise<LearnedInstallation>;
export function runLearnedChild(snapshotRoot: string, manifestPath: string, installation: LearnedInstallation, signal: AbortSignal, onMessage?: (message: any) => void): Promise<string>;
