import express from "express";

const defects = new Set((process.env.FIXTURE_DEFECTS ?? "").split(",").filter(Boolean));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 0);
let flakyFailures = 0;

const app = express();
app.use(express.json());

app.get("/ready", (_request, response) => response.json({ ready: true }));
app.post("/admin", (request, response) => {
  if (!defects.has("authz-gap") && request.get("authorization") !== "Bearer fixture-admin") {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  response.json({ updated: true });
});
app.get("/item", (_request, response) => {
  response.json(defects.has("schema-drift") ? { id: 1 } : { id: 1, name: "fixture" });
});
app.get("/health", (request, response) => {
  const trigger = request.query.fail === "1" || request.get("x-flaky") === "true";
  if (defects.has("flaky-500") && trigger && flakyFailures === 0) {
    flakyFailures += 1;
    response.status(500).json({ ok: false });
    return;
  }
  response.json({ ok: true });
});
app.get("/hang", (_request, _response) => {
  if (!defects.has("hang")) _response.json({ ok: true });
});

app.listen(port, host);
