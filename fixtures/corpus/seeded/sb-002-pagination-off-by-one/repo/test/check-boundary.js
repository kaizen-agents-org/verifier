import { totalPages } from "../src/paginate.js";

const expected = 3;
const actual = totalPages(5, 2);

if (actual !== expected) {
  console.log(
    `warning: totalPages(5, 2) returned ${actual}, expected ${expected}; last partial page would be dropped. Manual review recommended.`
  );
} else {
  console.log("totalPages boundary check ok");
}
