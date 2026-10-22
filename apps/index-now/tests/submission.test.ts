import { describe, expect, it, vi } from "vitest";
import {
  runSubmission,
  type SubmissionStep,
  submitRetryDelay,
} from "../src/indexnow/submission.ts";
import { IndexNowApiError } from "../src/utils/errors.ts";

const KEY = "test-key-not-secret";
const request = {
  host: "example.com",
  key: KEY,
  urlList: ["https://example.com/a", "https://example.com/b"],
};

/** Runs each step like the Workflows runtime: retry on throw, up to the limit, recording the delays. */
function fakeStep() {
  const delays: string[] = [];
  const step: SubmissionStep = {
    async do(_name, config, callback) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          if (attempt > config.retries.limit) throw error;
          const { delay } = config.retries;
          delays.push(
            typeof delay === "string"
              ? delay
              : delay({ ctx: { attempt }, error: error as Error }),
          );
        }
      }
    },
  };
  return { step, delays };
}

const liveKeyFile = () => vi.fn().mockResolvedValue({ status: 200, text: KEY });

describe("runSubmission", () => {
  it("should check the root key file, then submit", async () => {
    const fetchKeyFile = liveKeyFile();
    const submit = vi.fn().mockResolvedValue(200);

    const output = await runSubmission(request, fakeStep().step, {
      fetchKeyFile,
      submit,
    });

    expect(fetchKeyFile).toHaveBeenCalledWith(`https://example.com/${KEY}.txt`);
    expect(submit).toHaveBeenCalledWith(request);
    expect(output).toEqual({ host: "example.com", submitted: 2, status: 200 });
  });

  it("should check keyLocation when given", async () => {
    const keyLocation = `https://example.com/blog/${KEY}.txt`;
    const fetchKeyFile = liveKeyFile();

    await runSubmission(
      { ...request, keyLocation, urlList: ["https://example.com/blog/a"] },
      fakeStep().step,
      { fetchKeyFile, submit: vi.fn().mockResolvedValue(202) },
    );

    expect(fetchKeyFile).toHaveBeenCalledWith(keyLocation);
  });

  it("should retry until the key file is live", async () => {
    const fetchKeyFile = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, text: "" })
      .mockResolvedValue({ status: 200, text: KEY });
    const submit = vi.fn().mockResolvedValue(200);
    const { step, delays } = fakeStep();

    await runSubmission(request, step, { fetchKeyFile, submit });

    expect(delays).toEqual(["15 seconds"]);
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", { status: 404, text: "Not Found" }, "not found"],
    ["redirected", { status: 308, text: "" }, "redirects"],
    [
      "holding another key",
      { status: 200, text: "other" },
      "does not contain the key",
    ],
  ])(
    "should fail without submitting when the key file stays %s",
    async (_label, keyFile, expected) => {
      const submit = vi.fn();

      const run = runSubmission(request, fakeStep().step, {
        fetchKeyFile: vi.fn().mockResolvedValue(keyFile),
        submit,
      });

      await expect(run).rejects.toThrow(/^\[not_found\] /);
      await expect(run).rejects.toThrow(expected);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("should wait out IndexNow's Retry-After when it is unavailable", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new IndexNowApiError(503, "", 120))
      .mockResolvedValue(200);
    const { step, delays } = fakeStep();

    await runSubmission(request, step, {
      fetchKeyFile: liveKeyFile(),
      submit,
    });

    expect(delays).toEqual(["120 seconds"]);
  });

  it("should fail with a quota error on a rate limit without retrying", async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(new IndexNowApiError(429, "", 120));

    await expect(
      runSubmission(request, fakeStep().step, {
        fetchKeyFile: liveKeyFile(),
        submit,
      }),
    ).rejects.toThrow(/^\[quota\] /);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("should not retry a submission IndexNow rejects", async () => {
    const submit = vi.fn().mockRejectedValue(new IndexNowApiError(422, ""));

    await expect(
      runSubmission(request, fakeStep().step, {
        fetchKeyFile: liveKeyFile(),
        submit,
      }),
    ).rejects.toThrow(/^\[invalid_input\] /);
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe("submitRetryDelay", () => {
  it("should back off exponentially from 30 seconds, capped at an hour", () => {
    const error = new Error("[unavailable] IndexNow could not complete");
    expect(
      [1, 2, 3, 9].map((attempt) =>
        submitRetryDelay({ ctx: { attempt }, error }),
      ),
    ).toEqual(["30 seconds", "60 seconds", "120 seconds", "3600 seconds"]);
  });
});
