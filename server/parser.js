"use strict";

const KEYWORDS = new Set([
  "and",
  "atomic",
  "break",
  "continue",
  "do",
  "elif",
  "else",
  "end",
  "fail",
  "false",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "mod",
  "not",
  "od",
  "or",
  "readonly",
  "readwrite",
  "rec",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while"
]);

const MULTI_CHAR_TOKENS = [":=", ";;", "..", "->", "<>", "<=", ">="];
const SINGLE_CHAR_TOKENS = new Set([
  "(", ")", "[", "]", "{", "}", ",", ".", ";", ":", "+", "-", "*", "/", "^", "=", "<", ">", "~"
]);

function parseGapSource(text) {
  const tokens = tokenizeGapSource(text);
  const parser = new GapParser(text, tokens);
  return parser.parseProgram();
}

function tokenizeGapSource(text) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "#") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "\"") {
      tokens.push(readString(text, index));
      index = tokens[tokens.length - 1].end;
      continue;
    }

    if (char === "'") {
      tokens.push(readCharacter(text, index));
      index = tokens[tokens.length - 1].end;
      continue;
    }

    if (isIdentifierStart(char)) {
      const token = readIdentifier(text, index);
      tokens.push(KEYWORDS.has(token.text)
        ? { ...token, type: "keyword" }
        : token);
      index = token.end;
      continue;
    }

    if (isDigit(char) || (char === "." && isDigit(text[index + 1] || ""))) {
      const token = readNumber(text, index);
      tokens.push(token);
      index = token.end;
      continue;
    }

    const two = text.slice(index, index + 2);
    if (MULTI_CHAR_TOKENS.includes(two)) {
      tokens.push({
        type: two === ";;" ? "punctuation" : "operator",
        text: two,
        start: index,
        end: index + 2
      });
      index += 2;
      continue;
    }

    if (SINGLE_CHAR_TOKENS.has(char)) {
      tokens.push({
        type: char === ";" || "(),[]{}.".includes(char) ? "punctuation" : "operator",
        text: char,
        start: index,
        end: index + 1
      });
      index += 1;
      continue;
    }

    tokens.push({
      type: "unknown",
      text: char,
      start: index,
      end: index + 1
    });
    index += 1;
  }

  tokens.push({ type: "eof", text: "", start: text.length, end: text.length });
  return tokens;
}

function readString(text, start) {
  let index = start + 1;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    index += 1;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      break;
    }
  }

  return {
    type: "string",
    text: text.slice(start, index),
    start,
    end: index
  };
}

function readCharacter(text, start) {
  let index = start + 1;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    index += 1;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      break;
    }
  }

  return {
    type: "character",
    text: text.slice(start, index),
    start,
    end: index
  };
}

function readIdentifier(text, start) {
  let index = start + 1;

  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 2;
      continue;
    }
    if (!isIdentifierPart(char)) {
      break;
    }
    index += 1;
  }

  return {
    type: "identifier",
    text: text.slice(start, index),
    start,
    end: index
  };
}

function readNumber(text, start) {
  let index = start;
  let sawDot = false;

  if (text[index] === ".") {
    sawDot = true;
    index += 1;
  }

  while (index < text.length) {
    const char = text[index];
    if (isDigit(char)) {
      index += 1;
      continue;
    }
    if (char === "." && !sawDot && text[index + 1] !== ".") {
      sawDot = true;
      index += 1;
      continue;
    }
    break;
  }

  return {
    type: "number",
    text: text.slice(start, index),
    start,
    end: index
  };
}

class GapParser {
  constructor(text, tokens) {
    this.text = text;
    this.tokens = tokens;
    this.index = 0;
    this.errors = [];
  }

  parseProgram() {
    const statements = this.parseStatements(new Set());
    return {
      type: "program",
      start: 0,
      end: this.text.length,
      statements,
      tokens: this.tokens,
      errors: this.errors
    };
  }

  parseStatements(stopKeywords) {
    const statements = [];

    while (!this.isEof() && !this.isStopKeyword(stopKeywords)) {
      if (this.matchText(";") || this.matchText(";;")) {
        this.advance();
        continue;
      }

      const statement = this.parseStatement(stopKeywords);
      if (statement) {
        statements.push(statement);
      } else {
        this.synchronize(stopKeywords);
      }
    }

    return statements;
  }

  parseStatement(stopKeywords) {
    if (this.isKeyword("local")) {
      return this.parseLocalDeclaration();
    }
    if (this.isKeyword("return")) {
      return this.parseReturnStatement();
    }
    if (this.isKeyword("if")) {
      return this.parseIfStatement();
    }
    if (this.isKeyword("for")) {
      return this.parseForStatement();
    }
    if (this.isKeyword("while")) {
      return this.parseWhileStatement();
    }
    if (this.isKeyword("repeat")) {
      return this.parseRepeatStatement();
    }
    if (this.current().type === "identifier" && this.peek().text === ":=") {
      return this.parseAssignment();
    }

    return this.parseExpressionStatement(stopKeywords);
  }

  parseLocalDeclaration() {
    const startToken = this.expectKeyword("local");
    const names = [];

    while (!this.isEof() && !this.matchText(";") && !this.matchText(";;")) {
      if (this.current().type === "identifier") {
        const token = this.advance();
        names.push({ name: token.text, start: token.start, end: token.end });
        continue;
      }
      this.advance();
    }

    const semicolon = this.consumeSemicolon();
    return {
      type: "localDeclaration",
      start: startToken.start,
      end: semicolon ? semicolon.end : this.previousEnd(startToken.end),
      names
    };
  }

  parseReturnStatement() {
    const startToken = this.expectKeyword("return");
    let expression;

    if (!this.matchText(";") && !this.matchText(";;")) {
      expression = this.readExpressionUntil({ text: new Set([";", ";;"]) });
    }

    const semicolon = this.consumeSemicolon();
    return {
      type: "returnStatement",
      start: startToken.start,
      end: semicolon ? semicolon.end : (expression ? expression.end : startToken.end),
      expression
    };
  }

  parseIfStatement() {
    const startToken = this.expectKeyword("if");
    const branches = [];
    const condition = this.readExpressionUntil({ keyword: new Set(["then"]) });
    this.expectKeyword("then");
    const body = this.parseStatements(new Set(["elif", "else", "fi"]));
    branches.push({ kind: "if", condition, body });

    while (this.isKeyword("elif")) {
      this.advance();
      const elifCondition = this.readExpressionUntil({ keyword: new Set(["then"]) });
      this.expectKeyword("then");
      const elifBody = this.parseStatements(new Set(["elif", "else", "fi"]));
      branches.push({ kind: "elif", condition: elifCondition, body: elifBody });
    }

    let elseBody = [];
    if (this.isKeyword("else")) {
      this.advance();
      elseBody = this.parseStatements(new Set(["fi"]));
    }

    const fiToken = this.expectKeyword("fi");
    const semicolon = this.consumeSemicolon();
    return {
      type: "ifStatement",
      start: startToken.start,
      end: semicolon ? semicolon.end : fiToken.end,
      branches,
      elseBody
    };
  }

  parseForStatement() {
    const startToken = this.expectKeyword("for");
    const variable = this.readExpressionUntil({ keyword: new Set(["in"]) });
    this.expectKeyword("in");
    const iterator = this.readExpressionUntil({ keyword: new Set(["do"]) });
    this.expectKeyword("do");
    const body = this.parseStatements(new Set(["od"]));
    const odToken = this.expectKeyword("od");
    const semicolon = this.consumeSemicolon();
    return {
      type: "forStatement",
      start: startToken.start,
      end: semicolon ? semicolon.end : odToken.end,
      variable,
      iterator,
      body
    };
  }

  parseWhileStatement() {
    const startToken = this.expectKeyword("while");
    const condition = this.readExpressionUntil({ keyword: new Set(["do"]) });
    this.expectKeyword("do");
    const body = this.parseStatements(new Set(["od"]));
    const odToken = this.expectKeyword("od");
    const semicolon = this.consumeSemicolon();
    return {
      type: "whileStatement",
      start: startToken.start,
      end: semicolon ? semicolon.end : odToken.end,
      condition,
      body
    };
  }

  parseRepeatStatement() {
    const startToken = this.expectKeyword("repeat");
    const body = this.parseStatements(new Set(["until"]));
    this.expectKeyword("until");
    const condition = this.readExpressionUntil({ text: new Set([";", ";;"]) });
    const semicolon = this.consumeSemicolon();
    return {
      type: "repeatStatement",
      start: startToken.start,
      end: semicolon ? semicolon.end : condition.end,
      body,
      condition
    };
  }

  parseAssignment() {
    const nameToken = this.advance();
    const assignToken = this.expectText(":=");

    if (this.isKeyword("atomic") || this.isKeyword("function")) {
      const expression = this.parseFunctionExpression();
      const semicolon = this.consumeSemicolon();
      return {
        type: "functionAssignment",
        name: nameToken.text,
        nameStart: nameToken.start,
        nameEnd: nameToken.end,
        start: nameToken.start,
        end: semicolon ? semicolon.end : expression.end,
        assignStart: assignToken.start,
        expression,
        params: expression.params,
        body: expression.body,
        bodyStart: expression.bodyStart,
        bodyEnd: expression.bodyEnd
      };
    }

    const expression = this.readExpressionUntil({ text: new Set([";", ";;"]) });
    const semicolon = this.consumeSemicolon();
    return {
      type: "assignment",
      name: nameToken.text,
      nameStart: nameToken.start,
      nameEnd: nameToken.end,
      start: nameToken.start,
      end: semicolon ? semicolon.end : expression.end,
      assignStart: assignToken.start,
      expression
    };
  }

  parseFunctionExpression() {
    const start = this.current().start;
    let atomic = false;
    if (this.isKeyword("atomic")) {
      atomic = true;
      this.advance();
    }

    const functionToken = this.expectKeyword("function");
    const params = this.parseParameterList();
    const bodyStart = this.current().start;
    const body = this.parseStatements(new Set(["end"]));
    const bodyEnd = this.current().start;
    const endToken = this.expectKeyword("end");

    return {
      type: "functionExpression",
      start,
      end: endToken.end,
      functionStart: functionToken.start,
      atomic,
      params,
      body,
      bodyStart,
      bodyEnd
    };
  }

  parseParameterList() {
    const params = [];
    if (!this.matchText("(")) {
      this.error("'(' expected after function", this.current());
      return params;
    }
    this.advance();

    while (!this.isEof() && !this.matchText(")")) {
      if (this.current().type === "identifier") {
        const token = this.advance();
        params.push({ name: token.text, start: token.start, end: token.end });
        continue;
      }
      this.advance();
    }

    this.expectText(")");
    return params;
  }

  parseExpressionStatement(stopKeywords) {
    const expression = this.readExpressionUntil({
      text: new Set([";", ";;"]),
      keyword: stopKeywords
    });
    const semicolon = this.consumeSemicolon();
    return {
      type: "expressionStatement",
      start: expression.start,
      end: semicolon ? semicolon.end : expression.end,
      expression
    };
  }

  readExpressionUntil(terminators) {
    const startToken = this.current();
    const start = startToken.start;
    let end = start;
    let depth = 0;

    while (!this.isEof()) {
      const token = this.current();
      if (
        depth === 0 &&
        ((terminators.text && terminators.text.has(token.text)) ||
          (terminators.keyword && token.type === "keyword" && terminators.keyword.has(token.text)))
      ) {
        break;
      }

      if (["(", "[", "{"].includes(token.text)) {
        depth += 1;
      } else if ([")", "]", "}"].includes(token.text)) {
        depth = Math.max(0, depth - 1);
      }

      end = token.end;
      this.advance();
    }

    return expressionFromRange(this.text, start, end);
  }

  synchronize(stopKeywords) {
    while (!this.isEof()) {
      if (this.matchText(";") || this.matchText(";;")) {
        this.advance();
        return;
      }
      if (this.isStopKeyword(stopKeywords)) {
        return;
      }
      this.advance();
    }
  }

  consumeSemicolon() {
    if (this.matchText(";") || this.matchText(";;")) {
      return this.advance();
    }
    return undefined;
  }

  expectKeyword(keyword) {
    if (this.isKeyword(keyword)) {
      return this.advance();
    }
    this.error(`'${keyword}' expected`, this.current());
    return syntheticToken(keyword, this.current().start);
  }

  expectText(text) {
    if (this.matchText(text)) {
      return this.advance();
    }
    this.error(`'${text}' expected`, this.current());
    return syntheticToken(text, this.current().start);
  }

  error(message, token) {
    this.errors.push({
      message,
      start: token.start,
      end: token.end
    });
  }

  isKeyword(keyword) {
    return this.current().type === "keyword" && this.current().text === keyword;
  }

  isStopKeyword(stopKeywords) {
    return this.current().type === "keyword" && stopKeywords.has(this.current().text);
  }

  matchText(text) {
    return this.current().text === text;
  }

  current() {
    return this.tokens[this.index] || this.tokens[this.tokens.length - 1];
  }

  peek() {
    return this.tokens[this.index + 1] || this.tokens[this.tokens.length - 1];
  }

  advance() {
    const token = this.current();
    if (!this.isEof()) {
      this.index += 1;
    }
    return token;
  }

  isEof() {
    return this.current().type === "eof";
  }

  previousEnd(fallback) {
    const previous = this.tokens[this.index - 1];
    return previous ? previous.end : fallback;
  }
}

function expressionFromRange(text, start, end) {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  return {
    type: "expression",
    start: start + leading,
    end: end - trailing,
    text: raw.trim()
  };
}

function syntheticToken(text, start) {
  return {
    type: "synthetic",
    text,
    start,
    end: start
  };
}

function isIdentifierStart(char) {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_]/.test(char);
}

function isDigit(char) {
  return /[0-9]/.test(char);
}

module.exports = {
  parseGapSource,
  tokenizeGapSource
};
