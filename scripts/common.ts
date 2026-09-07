export const root = new URL('../', import.meta.url);
export function filePath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return Deno.build.os === 'windows'
    ? path.slice(1).replaceAll('/', '\\')
    : path;
}
export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    stdout: 'inherit',
    stderr: 'inherit',
    ...options,
  }).output();
  if (!result.success) throw new Error(`${command} exited with ${result.code}`);
}
