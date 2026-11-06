export function normalizeDialogPolicy(policy) {
  return policy ?? { accept: true };
}

function dialogFromOpening(params = {}) {
  return {
    type: params.type,
    message: params.message,
    defaultPrompt: params.defaultPrompt ?? "",
    url: params.url,
  };
}

function decisionFromResult(result) {
  if (typeof result === "boolean") return { accept: result };
  if (result && typeof result === "object") {
    const decision = { accept: result.accept !== false };
    if (result.promptText !== undefined) decision.promptText = result.promptText;
    return decision;
  }
  return { accept: true };
}

export async function resolveDialogAction(policy, params = {}) {
  try {
    const result = typeof policy === "function"
      ? await policy(dialogFromOpening(params))
      : policy;
    return decisionFromResult(result);
  } catch {
    return { accept: true };
  }
}

let isAnswered;
let answer;

// The "dialog" event object, shaped like Playwright's Dialog. The client makes one
// per Page.javascriptDialogOpening and hands it to listeners; it is answered at
// most once, by a listener through accept()/dismiss() or else by the policy.
export class Dialog {
  #params;
  #send;
  #answered = false;

  constructor(params, send) {
    this.#params = params ?? {};
    this.#send = send;
  }

  get url() { return this.#params.url; }
  type() { return this.#params.type; }
  message() { return this.#params.message; }
  defaultValue() { return this.#params.defaultPrompt ?? ""; }
  accept(promptText) {
    return this.#answer(promptText === undefined ? { accept: true } : { accept: true, promptText });
  }
  dismiss() { return this.#answer({ accept: false }); }

  // Marks the dialog answered before the first await, so a listener that
  // answers synchronously always wins over the policy.
  async #answer(action) {
    if (this.#answered) throw new Error("this dialog is already handled");
    this.#answered = true;
    await this.#send(action);
  }

  static {
    isAnswered = (dialog) => dialog.#answered;
    answer = (dialog, action) => dialog.#answer(action);
  }
}

// Runs once the dialog's listeners have run: the policy answers only a dialog
// none of them answered.
export async function answerWithPolicy(dialog, policy, params) {
  if (isAnswered(dialog)) return;
  const action = await resolveDialogAction(policy, params);
  if (!isAnswered(dialog)) await answer(dialog, action);
}
