import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Hono } from "hono";
import { handleMcp } from "./http.ts";
import {
  fetchKeyFile,
  type SubmissionWorkflow,
  type SubmitRequest,
  submitToIndexNow,
} from "./indexnow/client.ts";
import { runSubmission, type SubmissionStep } from "./indexnow/submission.ts";

interface Env {
  SUBMISSIONS: SubmissionWorkflow;
}

/** Durable IndexNow submission: retried across outages and deploys going live. */
export class SubmitWorkflow extends WorkflowEntrypoint<Env, SubmitRequest> {
  run(event: WorkflowEvent<SubmitRequest>, step: WorkflowStep) {
    return runSubmission(event.payload, step as SubmissionStep, {
      fetchKeyFile,
      submit: submitToIndexNow,
    });
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({ name: "index-now-mcp", status: "ok", mcp: "/mcp" }),
);

app.post("/mcp", (c) => handleMcp(c.req.raw, c.env.SUBMISSIONS));

export default app;
