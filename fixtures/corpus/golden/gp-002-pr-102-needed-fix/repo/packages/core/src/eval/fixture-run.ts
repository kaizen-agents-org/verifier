export function createCheckInput(fixtureCase, workspace, baseSha, verifyCommands) {
  return {
    task: fixtureCase.intent?.text ?? "",
    workspace,
    base: baseSha,
    verifyCommands,
    verifyTimeoutMs: fixtureCase.timeoutMinutes * 60_000
  };
}
