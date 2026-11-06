class CdpCommandError extends Error {
  constructor(name, message, details) {
    super(message);
    Object.assign(this, details);
    this.name = name;
  }
}

export class CdpCommandTimeoutError extends CdpCommandError {
  constructor(message, details) { super("CdpCommandTimeoutError", message, details); }
}

export class CdpPipeClosedError extends CdpCommandError {
  constructor(message, details) { super("CdpPipeClosedError", message, details); }
}

export class CdpSessionDetachedError extends CdpCommandError {
  constructor(message, details) { super("CdpSessionDetachedError", message, details); }
}

export class CdpSessionCrashedError extends CdpCommandError {
  constructor(message, details) { super("CdpSessionCrashedError", message, details); }
}
