// A recording BrowserSkill IPC client for BskSession tests: answers each method from `replies`.
export function stubClient(replies = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, options });
      const reply = replies[method];
      if (typeof reply === "function") return reply(params, calls.length);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
}

export function lastCall(client) { return client.calls.at(-1); }
