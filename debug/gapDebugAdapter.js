"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { collectProbeMetadata, instrumentGapSource } = require("./instrumenter");

const THREAD_ID = 1;
const LOCALS_REFERENCE = 1;
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
    const sourcePath = normalizePath(request.arguments && request.arguments.source && request.arguments.source.path);
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
        source: sourceFromPath(sourcePath)
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
      const text = fs.readFileSync(sourcePath, "utf8");
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
    const instrumented = instrumentGapSource(source, program, {
      maxValueLength: this.launchArgs.maxValueLength
    });
    this.probesByPath.set(program, instrumented.probes);
    this.probesById = new Map(instrumented.probes.map((probe) => [probe.id, probe]));

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap-debug-"));
    const instrumentedPath = path.join(this.tempDir, `${path.basename(program)}.debug.g`);
    fs.writeFileSync(instrumentedPath, instrumented.instrumented, "utf8");

    const command = this.launchArgs.gapCommand || defaultGapCommand();
    const configuredArgs = arrayValue(this.launchArgs.gapArgs);
    const args = configuredArgs.length > 0 ? configuredArgs : defaultGapArgs(command);
    args.push(commandUsesWsl(command, args) ? await windowsPathToWslPath(instrumentedPath) : instrumentedPath);

    this.runtime = childProcess.spawn(command, args, {
      cwd: path.dirname(program),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.runtime.stdout.on("data", (chunk) => this.handleRuntimeOutput(chunk));
    this.runtime.stderr.on("data", (chunk) => this.sendOutput(chunk.toString("utf8"), "stderr"));
    this.runtime.on("exit", (code) => {
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
        this.sendOutput(`${rawLine}\n`, "stdout");
      }
      return;
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

  decideProbeHit(hit) {
    const probe = this.probesById.get(hit.id) || hit;
    const breakpoints = this.breakpointsByPath.get(normalizePath(probe.sourcePath)) || new Map();
    const breakpoint = breakpoints.get(probe.line);
    const firstStop = this.launchArgs && this.launchArgs.stopOnEntry && !this.currentProbe;
    const shouldStep = this.shouldStopForStep(probe);
    const shouldStop = Boolean(firstStop || shouldStep || breakpoint || this.pauseRequested);

    this.currentProbe = { ...probe, ...hit };
    this.currentVariables = new Map((hit.variables || []).map((variable) => [variable.name, variable]));

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
      source: sourceFromPath(this.currentProbe.sourcePath),
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
        }
      ]
    });
  }

  variables(request) {
    if (request.arguments && request.arguments.variablesReference !== LOCALS_REFERENCE) {
      this.sendResponse(request, { variables: [] });
      return;
    }

    const variables = [...this.currentVariables.values()].map((variable) => ({
      name: variable.name,
      value: variable.bound ? variable.value : "<unbound>",
      type: variable.bound ? "GAP value" : "unbound",
      variablesReference: 0
    }));
    this.sendResponse(request, { variables });
  }

  evaluate(request) {
    const expression = String((request.arguments && request.arguments.expression) || "").trim();
    const variable = this.currentVariables.get(expression);
    if (variable) {
      this.sendResponse(request, {
        result: variable.bound ? variable.value : "<unbound>",
        variablesReference: 0
      });
      return;
    }

    this.sendResponse(request, {
      result: this.paused ? "Only simple captured variable names can be evaluated while paused." : "GAP is not paused.",
      variablesReference: 0
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

    this.paused = false;
    this.stepMode = stepMode;
    this.writeRuntimeCommand("__GAPDEBUG_CONTINUE__");
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
    const sourcePath = request.arguments && request.arguments.source && request.arguments.source.path;
    if (!sourcePath) {
      this.sendResponse(request, { content: "", mimeType: "text/plain" });
      return;
    }

    try {
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
    if (!this.tempDir) {
      return;
    }

    fs.rmSync(this.tempDir, {
      recursive: true,
      force: true
    });
    this.tempDir = undefined;
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
  return String(value)
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function normalizePath(value) {
  return value ? path.normalize(value) : "";
}

function sourceFromPath(sourcePath) {
  return {
    name: sourcePath ? path.basename(sourcePath) : "GAP",
    path: sourcePath
  };
}

function nearestProbeForLine(probes, line) {
  return (probes || []).find((probe) => probe.line >= line);
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
  parseHitLine,
  parseVariableLine,
  unescapeField
};
