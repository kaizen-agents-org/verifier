import { maxValue } from "../src/stats.js";

try {
  const result = maxValue([]);
  console.log(`maxValue([]) returned ${result} without throwing`);
} catch (error) {
  console.log(`error: maxValue([]) threw ${error.name}: ${error.message}`);
  process.exitCode = 1;
}
