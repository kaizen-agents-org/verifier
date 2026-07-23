import { ApiProbeDriver, type ApiProbeDriverOptions } from "@verifier/probe-driver-api";
import { CliProbeDriver, type CliProbeDriverOptions } from "@verifier/probe-driver-cli";
import type { ProbeDriver } from "@verifier/probe-sdk";

export function createBundledProbeDrivers(options: {
  cli: CliProbeDriverOptions;
  api: ApiProbeDriverOptions;
}): ProbeDriver[] {
  return [new CliProbeDriver(options.cli), new ApiProbeDriver(options.api)];
}
