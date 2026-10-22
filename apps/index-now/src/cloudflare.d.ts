// The parts of the Workers runtime module this Worker uses; the runtime
// provides it, so nothing here is bundled.
declare module "cloudflare:workers" {
  export interface WorkflowEvent<T> {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
  }

  export abstract class WorkflowStep {
    do<T>(
      name: string,
      config: Record<string, unknown>,
      callback: () => Promise<T>,
    ): Promise<T>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
    protected env: Env;
    abstract run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<unknown>;
  }
}
