"use strict";

const vscode = require("vscode");

const VIEW_ID = "gapSemanticObjects";

class GapSemanticObjectsProvider {
  constructor(outputChannel) {
    this.outputChannel = outputChannel;
    this.view = undefined;
    this.refreshToken = 0;
    this.state = {
      loading: false,
      unavailable: "Start debugging GAP code and pause at a breakpoint to inspect objects.",
      selectedObjectId: "",
      selectedName: "",
      variables: [],
      objects: [],
      results: {}
    };
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = semanticObjectsHtml();
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.postState();
    this.refresh();
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "refresh") {
      await this.refresh();
    } else if (message.type === "action") {
      await this.runAction(message.objectId, message.action);
    } else if (message.type === "select") {
      await this.selectObject(message.objectId);
    }
  }

  async focus() {
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } catch (_) {
      // Older VS Code builds may not expose a generated focus command.
    }
    await this.refresh();
  }

  async inspectVariable(variable) {
    const objectId = semanticObjectIdFromVariable(variable);
    const selectedName = semanticObjectNameFromVariable(variable) || objectId;
    if (!objectId) {
      await this.focus();
      return;
    }

    this.state = {
      loading: false,
      unavailable: "",
      selectedObjectId: objectId,
      selectedName,
      variables: this.state.variables || [],
      objects: [],
      results: {}
    };
    this.postState();
    await this.focus();
  }

  async selectObject(objectId) {
    objectId = String(objectId || "").trim();
    if (!objectId) {
      return;
    }
    const variable = (this.state.variables || []).find((candidate) => candidate.objectId === objectId);
    this.state = {
      ...this.state,
      selectedObjectId: objectId,
      selectedName: (variable && variable.name) || objectId,
      objects: [],
      results: {}
    };
    this.postState();
    await this.refresh();
  }

  async refresh() {
    const token = ++this.refreshToken;
    const session = activeGapDebugSession();
    if (!session) {
      this.state = {
        loading: false,
        unavailable: "Start a GAP debug session and pause at a breakpoint to inspect runtime objects.",
        error: "",
        selectedObjectId: this.state.selectedObjectId || "",
        selectedName: this.state.selectedName || "",
        variables: [],
        objects: [],
        results: {}
      };
      this.postState();
      return;
    }

    this.state = {
      ...this.state,
      loading: true,
      unavailable: "",
      error: ""
    };
    this.postState();

    try {
      const variablesResponse = await session.customRequest("gapSemanticVariables", {});
      if (token !== this.refreshToken) {
        return;
      }
      const variables = Array.isArray(variablesResponse && variablesResponse.variables) ? variablesResponse.variables : [];
      const objectId = chooseSelectedObjectId(this.state.selectedObjectId, variables);
      if (!objectId) {
        this.state = {
          ...this.state,
          loading: false,
          unavailable: (variablesResponse && variablesResponse.unavailable) || "No bound GAP variables are available at this pause point.",
          error: "",
          selectedObjectId: "",
          selectedName: "",
          variables,
          objects: [],
          results: {}
        };
        this.postState();
        return;
      }

      const response = await session.customRequest("gapSemanticObjects", {
        objectId
      });
      if (token !== this.refreshToken) {
        return;
      }
      const objects = Array.isArray(response && response.objects) ? response.objects : [];
      const selectedVariable = variables.find((variable) => variable.objectId === objectId);
      this.state = {
        ...this.state,
        loading: false,
        unavailable: (response && response.unavailable) || (objects.length === 0 ? `The selected GAP variable ${objectId} is not available at this pause point.` : ""),
        selectedObjectId: objectId,
        selectedName: (selectedVariable && selectedVariable.name) || objectId,
        variables,
        objects,
        results: this.retainActionResults(objects)
      };
      this.postState();
    } catch (error) {
      if (token !== this.refreshToken) {
        return;
      }
      this.state = {
        ...this.state,
        loading: false,
        unavailable: "",
        error: error && error.message ? error.message : "Could not inspect GAP objects.",
        variables: this.state.variables || [],
        objects: [],
        results: {}
      };
      this.postState();
      if (this.outputChannel) {
        this.outputChannel.appendLine(`GAP semantic object refresh failed: ${this.state.error}`);
      }
    }
  }

  async runAction(objectId, action) {
    objectId = String(objectId || "");
    action = String(action || "");
    if (!objectId || !action) {
      return;
    }

    const session = activeGapDebugSession();
    if (!session) {
      this.state = {
        ...this.state,
        error: "Start a GAP debug session and pause before running object actions."
      };
      this.postState();
      return;
    }

    const key = actionResultKey(objectId, action);
    this.state = {
      ...this.state,
      results: {
        ...this.state.results,
        [key]: {
          loading: true,
          result: "",
          error: ""
        }
      }
    };
    this.postState();

    try {
      const response = await session.customRequest("gapSemanticAction", {
        objectId,
        action
      });
      this.state = {
        ...this.state,
        results: {
          ...this.state.results,
          [key]: {
            loading: false,
            result: (response && response.result) || "",
            error: ""
          }
        }
      };
      this.postState();
    } catch (error) {
      const message = error && error.message ? error.message : "Could not run GAP object action.";
      this.state = {
        ...this.state,
        results: {
          ...this.state.results,
          [key]: {
            loading: false,
            result: "",
            error: message
          }
        }
      };
      this.postState();
      if (this.outputChannel) {
        this.outputChannel.appendLine(`GAP semantic action failed: ${message}`);
      }
    }
  }

  retainActionResults(objects) {
    const validObjectIds = new Set((objects || []).map((object) => object.objectId));
    const retained = {};
    for (const [key, value] of Object.entries(this.state.results || {})) {
      const objectId = key.split("::")[0];
      if (validObjectIds.has(objectId)) {
        retained[key] = value;
      }
    }
    return retained;
  }

  postState() {
    if (this.view && this.view.webview) {
      this.view.webview.postMessage({
        type: "state",
        state: this.state
      });
    }
  }
}

function registerSemanticObjectsSupport(context, outputChannel) {
  const provider = new GapSemanticObjectsProvider(outputChannel);
  const disposables = [
    vscode.commands.registerCommand("gapReference.openSemanticObjects", () => provider.focus()),
    vscode.commands.registerCommand("gapReference.inspectSemanticObject", (variable) => provider.inspectVariable(variable))
  ];

  if (vscode.window && typeof vscode.window.registerWebviewViewProvider === "function") {
    disposables.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));
  }
  if (vscode.debug && typeof vscode.debug.onDidStartDebugSession === "function") {
    disposables.push(vscode.debug.onDidStartDebugSession((session) => {
      if (session && session.type === "gap") {
        provider.refresh();
      }
    }));
  }
  if (vscode.debug && typeof vscode.debug.onDidTerminateDebugSession === "function") {
    disposables.push(vscode.debug.onDidTerminateDebugSession((session) => {
      if (session && session.type === "gap") {
        provider.refresh();
      }
    }));
  }
  if (vscode.debug && typeof vscode.debug.onDidChangeActiveDebugSession === "function") {
    disposables.push(vscode.debug.onDidChangeActiveDebugSession(() => provider.refresh()));
  }
  if (vscode.debug && typeof vscode.debug.onDidReceiveDebugSessionCustomEvent === "function") {
    disposables.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
      if (event && event.session && event.session.type === "gap" && event.event === "gapSemanticObjectsChanged") {
        provider.refresh();
      }
    }));
  }

  return vscode.Disposable && typeof vscode.Disposable.from === "function"
    ? vscode.Disposable.from(...disposables)
    : { dispose: () => disposables.forEach((disposable) => disposable && disposable.dispose && disposable.dispose()) };
}

function activeGapDebugSession() {
  const session = vscode.debug && vscode.debug.activeDebugSession;
  return session && session.type === "gap" && typeof session.customRequest === "function" ? session : undefined;
}

function actionResultKey(objectId, action) {
  return `${objectId}::${action}`;
}

function chooseSelectedObjectId(currentObjectId, variables) {
  const available = Array.isArray(variables) ? variables.filter((variable) => variable && variable.objectId) : [];
  if (currentObjectId && available.some((variable) => variable.objectId === currentObjectId)) {
    return currentObjectId;
  }

  const groupLike = available.find((variable) => /\b(?:Group|SymmetricGroup|AlternatingGroup|PermGroup)\b/.test(String(variable.value || "")));
  if (groupLike) {
    return groupLike.objectId;
  }

  const nonFunction = available.find((variable) => !/^function\b/.test(String(variable.value || "").trim()));
  return nonFunction ? nonFunction.objectId : (available[0] && available[0].objectId) || "";
}

function semanticObjectIdFromVariable(variable) {
  if (!variable || typeof variable !== "object") {
    return "";
  }
  if (typeof variable.__gapSemanticObjectId === "string" && variable.__gapSemanticObjectId.trim()) {
    return variable.__gapSemanticObjectId.trim();
  }
  if (typeof variable.evaluateName === "string" && variable.evaluateName.trim()) {
    return variable.evaluateName.trim();
  }
  return typeof variable.name === "string" ? variable.name.trim() : "";
}

function semanticObjectNameFromVariable(variable) {
  return variable && typeof variable.name === "string" ? variable.name.trim() : "";
}

function semanticObjectsHtml() {
  const nonce = String(Date.now());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .title {
      font-weight: 600;
      color: var(--vscode-sideBarTitle-foreground);
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 3px 8px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button.small {
      padding: 2px 6px;
      font-size: 11px;
    }
    .message {
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
      padding: 8px 0;
    }
    .error {
      color: var(--vscode-errorForeground);
    }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 10px;
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    .card-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .name {
      font-weight: 700;
    }
    .kind {
      color: var(--vscode-descriptionForeground);
      margin-left: 4px;
    }
    .view {
      margin-top: 5px;
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .facts {
      display: grid;
      grid-template-columns: minmax(82px, 0.45fr) minmax(0, 1fr);
      gap: 4px 8px;
      padding: 8px 10px;
    }
    .fact-label {
      color: var(--vscode-descriptionForeground);
    }
    .fact-value {
      font-family: var(--vscode-editor-font-family);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 0 10px 10px;
    }
    .variable-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin: 0 0 10px;
    }
    .variable-button {
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 2px 7px;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .variable-button.active {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
      border-color: var(--vscode-focusBorder);
    }
    .selected {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .result-card {
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBarSectionHeader-background);
    }
    .result-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .result-title {
      font-weight: 600;
    }
    .result-status {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .result-body {
      margin: 0;
      padding: 9px 10px 11px;
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .result-body.error {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <div class="title">GAP Objects</div>
      <div id="selected" class="selected"></div>
    </div>
    <button id="refresh" class="secondary" title="Refresh semantic objects">Refresh</button>
  </div>
  <div id="root" class="message">Waiting for GAP debug data.</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById("root");
    document.getElementById("refresh").addEventListener("click", () => {
      vscode.postMessage({ type: "refresh" });
    });
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "state") {
        render(event.data.state || {});
      }
    });
    function render(state) {
      root.replaceChildren();
      root.className = "";
      const selected = document.getElementById("selected");
      selected.textContent = state.selectedName ? "Selected: " + state.selectedName : "";
      if (state.loading) {
        appendMessage("Inspecting " + (state.selectedName || state.selectedObjectId || "selected GAP value") + "...");
      }
      if (state.error) {
        appendMessage(state.error, "error");
      }
      if (state.unavailable) {
        appendMessage(state.unavailable);
      }
      appendVariableStrip(state);
      const objects = Array.isArray(state.objects) ? state.objects : [];
      for (const object of objects) {
        root.appendChild(cardForObject(object, state.results || {}));
      }
      if (!state.loading && !state.error && !state.unavailable && objects.length === 0) {
        appendMessage("No semantic objects at this pause point.");
      }
    }
    function appendMessage(text, className) {
      const div = document.createElement("div");
      div.className = className ? "message " + className : "message";
      div.textContent = text;
      root.appendChild(div);
    }
    function appendVariableStrip(state) {
      const variables = Array.isArray(state.variables) ? state.variables : [];
      if (variables.length === 0) {
        return;
      }
      const strip = document.createElement("div");
      strip.className = "variable-strip";
      for (const variable of variables) {
        const button = document.createElement("button");
        button.className = variable.objectId === state.selectedObjectId ? "variable-button active" : "variable-button";
        button.title = (variable.scope || "variable") + " " + variable.name + " = " + (variable.value || "");
        button.textContent = variable.name || variable.objectId;
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "select",
            objectId: variable.objectId
          });
        });
        strip.appendChild(button);
      }
      root.appendChild(strip);
    }
    function cardForObject(object, results) {
      const card = document.createElement("section");
      card.className = "card";

      const header = document.createElement("div");
      header.className = "card-header";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = object.name || object.objectId || "<object>";
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = ": " + (object.label || "GAP object");
      header.append(name, kind);
      if (object.view) {
        const view = document.createElement("div");
        view.className = "view";
        view.textContent = object.view;
        header.appendChild(view);
      }
      card.appendChild(header);

      const facts = document.createElement("div");
      facts.className = "facts";
      appendFact(facts, "Known type", object.knownType || object.kind || "object");
      for (const fact of object.facts || []) {
        appendFact(facts, fact.label, fact.value);
      }
      card.appendChild(facts);

      const actions = document.createElement("div");
      actions.className = "actions";
      for (const action of object.actions || []) {
        const button = document.createElement("button");
        button.className = "secondary";
        button.textContent = action.label || action.action;
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "action",
            objectId: object.objectId,
            action: action.action
          });
        });
        actions.appendChild(button);
      }
      if (actions.childNodes.length > 0) {
        card.appendChild(actions);
      }

      for (const action of object.actions || []) {
        const key = object.objectId + "::" + action.action;
        const result = results[key];
        if (!result) {
          continue;
        }
        card.appendChild(resultCard(action, result));
      }

      return card;
    }
    function resultCard(action, result) {
      const section = document.createElement("section");
      section.className = "result-card";

      const header = document.createElement("div");
      header.className = "result-header";
      const title = document.createElement("div");
      title.className = "result-title";
      title.textContent = action.label || action.action;
      const right = document.createElement("div");
      right.className = "result-status";
      right.textContent = result.loading ? "Computing" : (result.error ? "Error" : "Result");
      header.append(title, right);

      if (!result.loading && !result.error && result.result) {
        const copy = document.createElement("button");
        copy.className = "secondary small";
        copy.textContent = "Copy";
        copy.addEventListener("click", () => {
          navigator.clipboard.writeText(result.result);
        });
        header.appendChild(copy);
      }

      const body = document.createElement("pre");
      body.className = result.error ? "result-body error" : "result-body";
      body.textContent = result.loading
        ? "Computing " + (action.label || action.action) + "..."
        : prettyGapText(result.error || result.result || "");

      section.append(header, body);
      return section;
    }
    function prettyGapText(text) {
      return String(text || "")
        .replace(/, rec\\(/g, ",\\nrec(")
        .replace(/\\), rec\\(/g, "),\\nrec(")
        .replace(/\\], \\[/g, "],\\n[")
        .replace(/, CharacterTable\\(/g, ",\\nCharacterTable(")
        .replace(/, Group\\(/g, ",\\nGroup(")
        .trim();
    }
    function appendFact(parent, label, value) {
      const left = document.createElement("div");
      left.className = "fact-label";
      left.textContent = label || "";
      const right = document.createElement("div");
      right.className = "fact-value";
      right.textContent = value == null ? "" : String(value);
      parent.append(left, right);
    }
  </script>
</body>
</html>`;
}

module.exports = {
  GapSemanticObjectsProvider,
  VIEW_ID,
  actionResultKey,
  chooseSelectedObjectId,
  registerSemanticObjectsSupport
};
