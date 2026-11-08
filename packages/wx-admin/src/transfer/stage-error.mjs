// Leaf module: cloud kinds import it without a cycle (they never import apply.mjs or kinds.mjs).
// A failed step of a multi-step write (create, publish, deploy, …): the result names the stage, and the id of the
// object when an earlier step made it (it is on the target then, and others can point at it).
export class StageError extends Error {
  constructor(stage, message, {id} = {}) {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
    if (id !== undefined) this.id = String(id);
  }
}
