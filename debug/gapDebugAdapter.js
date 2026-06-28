"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { collectProbeMetadata, instrumentGapSource } = require("./instrumenter");

const THREAD_ID = 1;
const LOCALS_REFERENCE = 1;
const GLOBALS_REFERENCE = 2;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

class GapDebugAdapter {
  constructor(input = process.stdin, output = process.stdout) {
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.nextSeq = 1;
    this.nextBreakpointId = 1;
    this.launchArgs = undefined;
    this.configurationDone = false;
    this.breakpointsByPath = new Map();
    this.probesByPath = new Map();
    this.probesById = new Map();
    this.runtime = undefined;
    this.runtimeBuffer = "";
    this.pendingHit = undefined;
    this.paused = false;
    this.pauseRequested = false;
    this.stepMode = undefined;
    this.currentProbe = undefined;
    this.currentVariables = new Map();
    this.tempDir = undefined;
    this.instrumentedPath = undefined;
    this.instrumentedRuntimePath = undefined;
    this.instrumentedLineMap = [];
    this.sourceTextByPath = new Map();
    this.sourceNameByPath = new Map();
    this.temporaryProgramDirectory = undefined;
    this.pendingRuntimeError = undefined;
    this.runtimeErrorTimer = undefined;
    this.lastRuntimeError = undefined;
    this.errorPaused = false;
    this.started = false;
  }

  start() {
    this.input.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainProtocolMessages();
    });
  }

  drainProtocolMessages() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = Buffer.alloc(0);
        return;
      }

      const length = Number.parseInt(lengthMatch[1], 10);
      const start = headerEnd + 4;
      const end = start + length;
      if (this.buffer.length < end) {
        return;
      }

      const message = JSON.parse(this.buffer.slice(start, end).toString("utf8"));
      this.buffer = this.buffer.slice(end);
      this.handleRequest(message).catch((error) => {
        if (message.type === "request") {
          this.sendResponse(message, undefined, false, error.message);
        }
      });
    }
  }

  async handleRequest(request) {
    if (request.type !== "request") {
      return;
    }

    switch (request.command) {
      case "initialize":
        this.sendResponse(request, {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsExceptionInfoRequest: true,
          supportsTerminateRequest: true
        });
        this.sendEvent("initialized");
        return;

      case "launch":
        this.launchArgs = request.arguments || {};
        this.sendResponse(request);
        await this.startRuntimeIfReady();
        return;

      case "setBreakpoints":
        this.setBreakpoints(request);
        return;

      case "setExceptionBreakpoints":
        this.sendResponse(request, { breakpoints: [] });
        return;

      case "configurationDone":
        this.configurationDone = true;
        this.sendResponse(request);
        await this.startRuntimeIfReady();
        return;

      case "threads":
        this.sendResponse(request, {
          threads: [
            {
              id: THREAD_ID,
              name: "GAP"
            }
          ]
        });
        return;

      case "stackTrace":
        this.stackTrace(request);
        return;

      case "scopes":
        this.scopes(request);
        return;

      case "variables":
        this.variables(request);
        return;

      case "evaluate":
        this.evaluate(request);
        return;

      case "exceptionInfo":
        this.exceptionInfo(request);
        return;

      case "continue":
        this.resume(request, undefined);
        return;

      case "next":
        this.resume(request, "next");
        return;

      case "stepIn":
        this.resume(request, "stepIn");
        return;

      case "stepOut":
        this.resume(request, "stepOut");
        return;

      case "pause":
        this.pause(request);
        return;

      case "disconnect":
      case "terminate":
        this.disconnect(request);
        return;

      case "source":
        this.source(request);
        return;

      default:
        this.sendResponse(request);
    }
  }

  setBreakpoints(request) {
    const sourcePath = normalizeSourcePath(request.arguments && request.arguments.source && request.arguments.source.path);
    const requested = (request.arguments && request.arguments.breakpoints) || [];
    const probeLines = sourcePath ? this.probeLinesForPath(sourcePath) : [];
    const breakpoints = [];
    const stored = new Map();

    for (const requestedBreakpoint of requested) {
      const requestedLine = requestedBreakpoint.line;
      const probe = nearestProbeForLine(probeLines, requestedLine);
      const verified = Boolean(probe);
      const line = probe ? probe.line : requestedLine;
      const breakpoint = {
        id: this.nextBreakpointId,
        verified,
        line,
        source: this.sourceFromPath(sourcePath)
      };
      this.nextBreakpointId += 1;
      if (!verified) {
        breakpoint.message = "No executable GAP statement was found for this breakpoint.";
      } else {
        stored.set(line, breakpoint);
      }
      breakpoints.push(breakpoint);
    }

    if (sourcePath) {
      this.breakpointsByPath.set(sourcePath, stored);
    }
    this.sendResponse(request, { breakpoints });
  }

  probeLinesForPath(sourcePath) {
    if (this.probesByPath.has(sourcePath)) {
      return this.probesByPath.get(sourcePath);
    }

    try {
      const text = this.sourceTextByPath.get(sourcePath) || fs.readFileSync(sourcePath, "utf8");
      const probes = collectProbeMetadata(text, sourcePath);
      this.probesByPath.set(sourcePath, probes);
      return probes;
    } catch (_) {
      this.probesByPath.set(sourcePath, []);
      return [];
    }
  }

  async startRuntimeIfReady() {
    if (this.started || !this.launchArgs || !this.configurationDone) {
      return;
    }
    this.started = true;

    const program = normalizePath(this.launchArgs.program);
    if (!program) {
      throw new Error("GAP debug launch requires a program path.");
    }

    const source = fs.readFileSync(program, "utf8");
    const sourcePath = normalizeSourcePath(this.launchArgs.sourcePath || program);
    const sourceName = this.launchArgs.sourceName ? String(this.launchArgs.sourceName) : undefined;
    this.sourceTextByPath.set(sourcePath, source);
    if (sourceName) {
      this.sourceNameByPath.set(sourcePath, sourceName);
    }
    this.temporaryProgramDirectory = normalizePath(this.launchArgs.temporaryProgramDirectory);

    const instrumented = instrumentGapSource(source, sourcePath, {
      maxValueLength: this.launchArgs.maxValueLength,
      runtimePrelude: this.launchArgs.runtimePrelude
    });
    this.probesByPath.set(sourcePath, instrumented.probes);
    this.probesById = new Map(instrumented.probes.map((probe) => [probe.id, probe]));
    this.instrumentedLineMap = instrumented.lineMap || [];
    this.applyLaunchBreakpoints(sourcePath, this.launchArgs.breakpoints);

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap-debug-"));
    const instrumentedPath = path.join(this.tempDir, `${path.basename(program)}.debug.g`);
    this.instrumentedPath = instrumentedPath;
    fs.writeFileSync(instrumentedPath, instrumented.instrumented, "utf8");

    const command = this.launchArgs.gapCommand || defaultGapCommand();
    const configuredArgs = arrayValue(this.launchArgs.gapArgs);
    const args = configuredArgs.length > 0 ? configuredArgs : defaultGapArgs(command);
    this.instrumentedRuntimePath = commandUsesWsl(command, args) ? await windowsPathToWslPath(instrumentedPath) : instrumentedPath;
    args.push(this.instrumentedRuntimePath);

    this.runtime = childProcess.spawn(command, args, {
      cwd: normalizePath(this.launchArgs.cwd) || path.dirname(program),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.runtime.stdout.on("data", (chunk) => this.handleRuntimeOutput(chunk));
    this.runtime.stderr.on("data", (chunk) => this.handleRuntimeStderr(chunk));
    this.runtime.on("exit", (code) => {
      this.flushRuntimeBuffer();
      this.runtime = undefined;
      this.sendEvent("exited", { exitCode: typeof code === "number" ? code : 0 });
      this.sendEvent("terminated");
      this.cleanupTempDir();
    });
  }

  handleRuntimeOutput(chunk) {
    this.runtimeBuffer += chunk.toString("utf8");
    while (true) {
      const newline = this.runtimeBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const rawLine = this.runtimeBuffer.slice(0, newline);
      this.runtimeBuffer = this.runtimeBuffer.slice(newline + 1);
      this.handleRuntimeLine(rawLine.replace(/\r$/, ""));
    }
  }

  handleRuntimeLine(rawLine) {
    const line = rawLine.replace(ANSI_RE, "");
    const markerIndex = line.indexOf("__GAPDEBUG_");
    if (markerIndex < 0) {
      if (rawLine.length > 0) {
        const rewritten = this.rewriteRuntimeOutput(rawLine);
        this.sendOutput(`${rewritten}\n`, "stdout");
        this.observeRuntimeOutputForError(this.rewriteRuntimeOutput(line));
      }
      return;
    }

    if (markerIndex > 0) {
      const prefix = line.slice(0, markerIndex);
      const rewritten = this.rewriteRuntimeOutput(prefix);
      this.sendOutput(rewritten, "stdout");
      this.observeRuntimeOutputForError(rewritten);
    }

    const markerLine = line.slice(markerIndex);
    if (markerLine.startsWith("__GAPDEBUG_HIT__\t")) {
      this.pendingHit = parseHitLine(markerLine);
      this.pendingHit.variables = [];
      return;
    }

    if (markerLine.startsWith("__GAPDEBUG_VAR__\t") && this.pendingHit) {
      this.pendingHit.variables.push(parseVariableLine(markerLine));
      return;
    }

    if (markerLine === "__GAPDEBUG_END__" && this.pendingHit) {
      const hit = this.pendingHit;
      this.pendingHit = undefined;
      this.decideProbeHit(hit);
    }
  }

  applyLaunchBreakpoints(sourcePath, requestedBreakpoints) {
    if (!Array.isArray(requestedBreakpoints) || requestedBreakpoints.length === 0) {
      return;
    }

    sourcePath = normalizeSourcePath(sourcePath);
    const probes = this.probesByPath.get(sourcePath) || [];
    const stored = this.breakpointsByPath.get(sourcePath) || new Map();
    for (const requestedBreakpoint of requestedBreakpoints) {
      const line = Number.parseInt(requestedBreakpoint.line, 10);
      if (!Number.isInteger(line)) {
        continue;
      }
      const probe = nearestProbeForLine(probes, line);
      if (!probe) {
        continue;
      }
      if (!stored.has(probe.line)) {
        stored.set(probe.line, {
          id: this.nextBreakpointId,
          verified: true,
          line: probe.line,
          source: this.sourceFromPath(sourcePath)
        });
        this.nextBreakpointId += 1;
      }
    }
    this.breakpointsByPath.set(sourcePath, stored);
  }

  flushRuntimeBuffer() {
    if (!this.runtimeBuffer) {
      return;
    }

    const pending = this.runtimeBuffer;
    this.runtimeBuffer = "";
    const markerIndex = pending.replace(ANSI_RE, "").indexOf("__GAPDEBUG_");
    if (markerIndex < 0) {
      const rewritten = this.rewriteRuntimeOutput(pending);
      this.sendOutput(rewritten, "stdout");
      this.observeRuntimeOutputForError(rewritten.replace(ANSI_RE, ""));
    }
  }

  handleRuntimeStderr(chunk) {
    const text = chunk.toString("utf8");
    const rewritten = this.rewriteRuntimeOutput(text);
    this.sendOutput(rewritten, "stderr");
    this.observeRuntimeOutputForError(rewritten.replace(ANSI_RE, ""));
  }

  rewriteRuntimeOutput(output) {
    return rewriteInstrumentedLocations(output, [this.instrumentedRuntimePath, this.instrumentedPath], this.instrumentedLineMap);
  }

  observeRuntimeOutputForError(text) {
    if (this.paused || this.errorPaused) {
      return;
    }

    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line && !this.pendingRuntimeError) {
        continue;
      }

      if (!this.pendingRuntimeError) {
        if (!hasGapRuntimeError(line)) {
          continue;
        }
        this.pendingRuntimeError = createRuntimeErrorInfo(this.currentProbe, line);
      } else if (line.trim()) {
        this.pendingRuntimeError.lines.push(line.trimEnd());
      }

      if (isGapRuntimeErrorPrompt(line)) {
        this.flushRuntimeErrorPause();
        return;
      }
    }

    if (this.pendingRuntimeError) {
      this.scheduleRuntimeErrorPause();
    }
  }

  scheduleRuntimeErrorPause() {
    if (this.runtimeErrorTimer) {
      clearTimeout(this.runtimeErrorTimer);
    }
    this.runtimeErrorTimer = setTimeout(() => {
      this.runtimeErrorTimer = undefined;
      this.flushRuntimeErrorPause();
    }, 100);
  }

  flushRuntimeErrorPause() {
    if (this.paused || this.errorPaused || !this.pendingRuntimeError) {
      return;
    }

    if (this.runtimeErrorTimer) {
      clearTimeout(this.runtimeErrorTimer);
      this.runtimeErrorTimer = undefined;
    }

    const errorInfo = finalizeRuntimeErrorInfo(this.pendingRuntimeError);
    this.pendingRuntimeError = undefined;
    this.lastRuntimeError = errorInfo;
    this.paused = true;
    this.errorPaused = true;
    this.pauseRequested = false;
    this.stepMode = undefined;

    if (errorInfo.location) {
      this.sendOutput(`GAP debugger paused on error near ${errorInfo.location}\n`, "stderr");
    }

    this.sendEvent("gapRuntimeError", {
      sourcePath: errorInfo.sourcePath,
      line: errorInfo.line,
      column: errorInfo.column,
      message: errorInfo.message,
      details: errorInfo.details
    });
    this.sendEvent("stopped", {
      reason: "exception",
      description: "GAP error",
      text: runtimeErrorPopupText(errorInfo),
      threadId: THREAD_ID,
      allThreadsStopped: true
    });
  }

  decideProbeHit(hit) {
    const probe = this.probesById.get(hit.id) || hit;
    const breakpoints = this.breakpointsByPath.get(normalizeSourcePath(probe.sourcePath)) || new Map();
    const breakpoint = breakpoints.get(probe.line);
    const firstStop = this.launchArgs && this.launchArgs.stopOnEntry && !this.currentProbe;
    const shouldStep = this.shouldStopForStep(probe);
    const shouldStop = Boolean(firstStop || shouldStep || breakpoint || this.pauseRequested);

    this.currentProbe = { ...probe, ...hit };
    this.pendingRuntimeError = undefined;
    this.lastRuntimeError = undefined;
    this.errorPaused = false;
    const variableScopes = new Map((probe.variables || []).map((variable) => [variable.name, variable.scope || "local"]));
    this.currentVariables = new Map((hit.variables || []).map((variable) => [
      variable.name,
      {
        ...variable,
        scope: variableScopes.get(variable.name) || "local"
      }
    ]));

    if (!shouldStop) {
      this.writeRuntimeCommand("__GAPDEBUG_CONTINUE__");
      return;
    }

    const reason = firstStop ? "entry" : (breakpoint ? "breakpoint" : (this.pauseRequested ? "pause" : "step"));
    this.paused = true;
    this.pauseRequested = false;
    this.stepMode = undefined;
    this.sendEvent("stopped", {
      reason,
      threadId: THREAD_ID,
      allThreadsStopped: true,
      hitBreakpointIds: breakpoint ? [breakpoint.id] : undefined
    });
  }

  shouldStopForStep(probe) {
    if (!this.stepMode) {
      return false;
    }
    if (this.stepMode.kind === "stepIn") {
      return true;
    }
    if (this.stepMode.kind === "next") {
      return probe.depth <= this.stepMode.depth;
    }
    if (this.stepMode.kind === "stepOut") {
      return probe.depth < this.stepMode.depth;
    }
    return false;
  }

  stackTrace(request) {
    if (!this.currentProbe) {
      this.sendResponse(request, { stackFrames: [], totalFrames: 0 });
      return;
    }

    const frame = {
      id: 1,
      name: this.currentProbe.functionName || "GAP",
      source: this.sourceFromPath(this.currentProbe.sourcePath),
      line: this.currentProbe.line,
      column: this.currentProbe.column || 1
    };
    this.sendResponse(request, {
      stackFrames: [frame],
      totalFrames: 1
    });
  }

  scopes(request) {
    this.sendResponse(request, {
      scopes: [
        {
          name: "Locals",
          variablesReference: LOCALS_REFERENCE,
          expensive: false
        },
        {
          name: "Globals",
          variablesReference: GLOBALS_REFERENCE,
          expensive: false
        }
      ]
    });
  }

  variables(request) {
    const reference = request.arguments && request.arguments.variablesReference;
    if (reference !== LOCALS_REFERENCE && reference !== GLOBALS_REFERENCE) {
      this.sendResponse(request, { variables: [] });
      return;
    }

    const scope = reference === GLOBALS_REFERENCE ? "global" : "local";
    const variables = [...this.currentVariables.values()]
      .filter((variable) => variable.scope === scope)
      .map((variable) => ({
        name: variable.name,
        value: runtimeVariableValue(variable),
        type: variable.bound ? "GAP value" : "unbound",
        variablesReference: 0
      }));
    this.sendResponse(request, { variables });
  }

  evaluate(request) {
    const expression = String((request.arguments && request.arguments.expression) || "").trim();
    const context = request.arguments && request.arguments.context;
    const variable = this.currentVariables.get(expression);
    if (variable) {
      if (context === "hover" && isFunctionValue(variable.value)) {
        this.sendResponse(request, undefined, false, "Runtime hover is not available for GAP functions.");
        return;
      }
      this.sendResponse(request, {
        result: runtimeVariableValue(variable),
        variablesReference: 0
      });
      return;
    }

    if (context === "hover") {
      this.sendResponse(request, undefined, false, "Expression is not a captured GAP variable.");
      return;
    }

    this.sendResponse(request, {
      result: this.paused ? "Only simple captured variable names can be evaluated while paused." : "GAP is not paused.",
      variablesReference: 0
    });
  }

  exceptionInfo(request) {
    const errorInfo = this.lastRuntimeError;
    if (!errorInfo) {
      this.sendResponse(request, {
        exceptionId: "GAP error",
        breakMode: "always"
      });
      return;
    }

    this.sendResponse(request, {
      exceptionId: "GAP runtime error",
      description: runtimeErrorPopupText(errorInfo),
      breakMode: "always",
      details: {
        message: errorInfo.message,
        typeName: "GAP runtime error",
        stackTrace: errorInfo.details
      }
    });
  }

  resume(request, stepKind) {
    this.sendResponse(request, {
      allThreadsContinued: true
    });

    const stepMode = stepKind ? {
      kind: stepKind,
      depth: this.currentProbe ? this.currentProbe.depth : 0
    } : undefined;

    if (!this.paused) {
      this.stepMode = stepMode;
      return;
    }

    const wasErrorPaused = this.errorPaused;
    this.paused = false;
    this.lastRuntimeError = wasErrorPaused ? this.lastRuntimeError : undefined;
    this.errorPaused = false;
    this.stepMode = wasErrorPaused ? undefined : stepMode;
    this.writeRuntimeCommand(wasErrorPaused ? "quit;" : "__GAPDEBUG_CONTINUE__");
  }

  pause(request) {
    this.pauseRequested = true;
    this.sendResponse(request);
    if (this.paused) {
      this.sendEvent("stopped", {
        reason: "pause",
        threadId: THREAD_ID,
        allThreadsStopped: true
      });
    }
  }

  source(request) {
    const sourcePath = normalizeSourcePath(request.arguments && request.arguments.source && request.arguments.source.path);
    if (!sourcePath) {
      this.sendResponse(request, { content: "", mimeType: "text/plain" });
      return;
    }

    try {
      if (this.sourceTextByPath.has(sourcePath)) {
        this.sendResponse(request, {
          content: this.sourceTextByPath.get(sourcePath),
          mimeType: "text/x-gap"
        });
        return;
      }
      this.sendResponse(request, {
        content: fs.readFileSync(sourcePath, "utf8"),
        mimeType: "text/x-gap"
      });
    } catch (_) {
      this.sendResponse(request, { content: "", mimeType: "text/plain" });
    }
  }

  disconnect(request) {
    this.sendResponse(request);
    if (this.runtime) {
      this.runtime.kill();
      this.runtime = undefined;
    }
    this.cleanupTempDir();
    this.sendEvent("terminated");
  }

  sourceFromPath(sourcePath) {
    return sourceFromPath(sourcePath, this.sourceNameByPath.get(normalizeSourcePath(sourcePath)));
  }

  writeRuntimeCommand(command) {
    if (this.runtime && this.runtime.stdin.writable) {
      this.runtime.stdin.write(`${command}\n`);
    }
  }

  sendOutput(output, category) {
    this.sendEvent("output", {
      category,
      output
    });
  }

  sendResponse(request, body, success = true, message) {
    this.writeProtocolMessage({
      seq: this.nextSeq,
      type: "response",
      request_seq: request.seq,
      success,
      command: request.command,
      message,
      body
    });
    this.nextSeq += 1;
  }

  sendEvent(event, body) {
    this.writeProtocolMessage({
      seq: this.nextSeq,
      type: "event",
      event,
      body
    });
    this.nextSeq += 1;
  }

  writeProtocolMessage(message) {
    const payload = JSON.stringify(message);
    this.output.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  }

  cleanupTempDir() {
    if (this.runtimeErrorTimer) {
      clearTimeout(this.runtimeErrorTimer);
      this.runtimeErrorTimer = undefined;
    }
    this.pendingRuntimeError = undefined;

    if (this.tempDir) {
      fs.rmSync(this.tempDir, {
        recursive: true,
        force: true
      });
      this.tempDir = undefined;
    }

    if (isNotebookTemporaryProgramDirectory(this.temporaryProgramDirectory)) {
      fs.rmSync(this.temporaryProgramDirectory, {
        recursive: true,
        force: true
      });
    }
    this.temporaryProgramDirectory = undefined;
  }
}

function parseHitLine(line) {
  const parts = line.split("\t");
  return {
    id: Number.parseInt(parts[1], 10),
    sourcePath: unescapeField(parts[2] || ""),
    line: Number.parseInt(parts[3], 10),
    column: Number.parseInt(parts[4], 10),
    functionName: unescapeField(parts[5] || "GAP"),
    depth: Number.parseInt(parts[6], 10)
  };
}

function parseVariableLine(line) {
  const parts = line.split("\t");
  return {
    name: unescapeField(parts[1] || ""),
    bound: parts[2] === "true",
    value: unescapeField(parts.slice(3).join("\t"))
  };
}

function unescapeField(value) {
  const text = String(value);
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\\" || index === text.length - 1) {
      result += char;
      continue;
    }

    const next = text[index + 1];
    index += 1;
    if (next === "n") {
      result += "\n";
    } else if (next === "r") {
      result += "\r";
    } else if (next === "t") {
      result += "\t";
    } else if (next === "\"" || next === "\\") {
      result += next;
    } else {
      result += `\\${next}`;
    }
  }
  return result;
}

function normalizePath(value) {
  return value ? path.normalize(value) : "";
}

function isNotebookTemporaryProgramDirectory(directory) {
  if (!directory) {
    return false;
  }
  const normalized = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, normalized);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(normalized).startsWith("gap-notebook-cell-"));
}

function normalizeSourcePath(value) {
  const text = String(value || "");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
    return text;
  }
  return normalizePath(text);
}

function sourceFromPath(sourcePath, sourceName) {
  return {
    name: sourceName || sourceNameFromPath(sourcePath),
    path: sourcePath
  };
}

function sourceNameFromPath(sourcePath) {
  if (!sourcePath) {
    return "GAP";
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(sourcePath)) {
    try {
      const parsed = new URL(sourcePath);
      const pathname = decodeURIComponent(parsed.pathname || "");
      return path.basename(pathname) || "GAP notebook cell";
    } catch (_) {
      return "GAP notebook cell";
    }
  }
  return path.basename(sourcePath);
}

function nearestProbeForLine(probes, line) {
  return (probes || []).find((probe) => probe.line >= line);
}

function rewriteInstrumentedLocations(output, instrumentedPaths, lineMap) {
  let rewritten = String(output || "");
  const paths = [...new Set((instrumentedPaths || []).filter(Boolean).map(String))];
  for (const instrumentedPath of paths) {
    const pattern = new RegExp(`${escapeRegExp(instrumentedPath)}:(\\d+)(?::(\\d+))?`, "g");
    rewritten = rewritten.replace(pattern, (match, lineText) => {
      const mapped = lineMap && lineMap[Number.parseInt(lineText, 10)];
      return mapped && mapped.sourcePath && mapped.line
        ? `${mapped.sourcePath}:${mapped.line}`
        : match;
    });
  }
  return rewritten;
}

function createRuntimeErrorInfo(currentProbe, firstLine) {
  const sourcePath = currentProbe && currentProbe.sourcePath;
  const line = currentProbe && currentProbe.line;
  const column = currentProbe && currentProbe.column || 1;
  return {
    sourcePath,
    line,
    column,
    location: sourcePath && line ? `${sourcePath}:${line}` : undefined,
    lines: [String(firstLine || "").trimEnd()]
  };
}

function finalizeRuntimeErrorInfo(errorInfo) {
  const lines = (errorInfo.lines || [])
    .map((line) => String(line || "").trimEnd())
    .filter(Boolean);
  const message = extractRuntimeErrorMessage(lines);
  const details = compactRuntimeErrorDetails(lines, errorInfo.location);
  return {
    ...errorInfo,
    lines,
    message,
    details
  };
}

function extractRuntimeErrorMessage(lines) {
  const index = lines.findIndex((line) => hasGapRuntimeError(line));
  if (index < 0) {
    return "GAP runtime error";
  }

  const messageLines = [lines[index].trim()];
  for (const line of lines.slice(index + 1)) {
    const trimmed = line.trim();
    if (!trimmed || /^(func\(|<function|called from|type 'quit;')/.test(trimmed)) {
      break;
    }
    messageLines.push(trimmed);
  }
  return messageLines.join("\n");
}

function compactRuntimeErrorDetails(lines, location) {
  const relevant = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^type 'quit;'/.test(line));
  if (location && !relevant.some((line) => line.includes(location))) {
    relevant.push(`Original source: ${location}`);
  }
  return relevant.slice(0, 10).join("\n");
}

function runtimeErrorPopupText(errorInfo) {
  const pieces = [errorInfo.message];
  if (errorInfo.location) {
    pieces.push(`Location: ${errorInfo.location}`);
  }
  if (errorInfo.details) {
    const detailLines = errorInfo.details
      .split(/\n/)
      .filter((line) => line && line !== errorInfo.message && !line.startsWith("Original source:"))
      .slice(0, 4);
    if (detailLines.length > 0) {
      pieces.push(detailLines.join("\n"));
    }
  }
  return pieces.filter(Boolean).join("\n");
}

function hasGapRuntimeError(text) {
  return /(^|\n)Error[,:\s]/.test(String(text || ""));
}

function isGapRuntimeErrorPrompt(text) {
  return /type 'quit;' to quit to outer loop/.test(String(text || ""));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runtimeVariableValue(variable) {
  if (!variable || !variable.bound) {
    return "<unbound>";
  }
  if (isFunctionValue(variable.value)) {
    return compactFunctionValue(variable.value);
  }
  return variable.value;
}

function isFunctionValue(value) {
  return /^function\s*\(/.test(String(value || "").trim());
}

function compactFunctionValue(value) {
  const text = String(value || "").trim();
  const signatureMatch = /^function\s*\(([^)]*)\)/.exec(text);
  const signature = signatureMatch ? `function (${signatureMatch[1].trim()})` : "function";
  return `${signature} ... end`;
}

function defaultGapCommand() {
  return process.platform === "win32" ? "wsl" : "gap";
}

function defaultGapArgs(command) {
  return command === "wsl" || /(?:^|[\\/])wsl(?:\.exe)?$/i.test(command)
    ? ["gap", "-q", "-x", "100000"]
    : ["-q", "-x", "100000"];
}

function commandUsesWsl(command, args) {
  return command === "wsl" || /(?:^|[\\/])wsl(?:\.exe)?$/i.test(command) || args[0] === "gap" && process.platform === "win32";
}

function arrayValue(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

async function windowsPathToWslPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return new Promise((resolve, reject) => {
    childProcess.execFile("wsl", ["wslpath", "-a", normalized], {
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

if (require.main === module) {
  new GapDebugAdapter().start();
}

module.exports = {
  GapDebugAdapter,
  normalizeSourcePath,
  parseHitLine,
  parseVariableLine,
  rewriteInstrumentedLocations,
  runtimeVariableValue,
  unescapeField
};
