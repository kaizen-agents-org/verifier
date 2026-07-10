import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.js";

test("slugifies a simple title", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses repeated punctuation", () => {
  assert.equal(slugify("A -- B!! C"), "a-b-c");
});

test("trims trailing separators", () => {
  assert.equal(slugify("trailing punctuation..."), "trailing-punctuation");
});
