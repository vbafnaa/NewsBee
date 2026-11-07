export class ExecutionBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionBlocked";
  }
}
