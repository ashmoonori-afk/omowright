export function subscribeConsoleEvents(page) {
  return page.cdp.on("Runtime.consoleAPICalled", (event, metadata) => {
    if (!metadata.sessionId || !page.frameManager.hasSession(metadata.sessionId)) return;
    const text = (event.args ?? []).map(arg => {
      if (arg.unserializableValue !== undefined) return arg.unserializableValue;
      if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : String(arg.value);
      return arg.description ?? arg.type;
    }).join(" ");
    page.events.emit("console", { type: () => event.type, text: () => text })
      .catch(error => console.warn("[console] page event listener failed", error));
  });
}
