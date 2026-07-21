export function logStartup(env, output = console.log) {
  output(`service=${env.SERVICE_NAME ?? "unknown"}`);
}
