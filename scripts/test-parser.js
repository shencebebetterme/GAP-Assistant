"use strict";

const assert = require("assert");
const { parseGapSource, tokenizeGapSource } = require("../server/parser");

const sample = `# Parser sample
G := SymmetricGroup(4);

f := function(n)
    local values;
    values := List([1 .. n], i -> Factorial(i));
    if IsList(values) then
        return values;
    else
        return [];
    fi;
end;

for x in [1 .. 3] do
    G := Group(());
od;
`;

const tokens = tokenizeGapSource(sample);
assert(tokens.some((token) => token.type === "keyword" && token.text === "function"), "tokenizer should classify function");
assert(tokens.some((token) => token.type === "operator" && token.text === ":="), "tokenizer should classify :=");
assert(!tokens.some((token) => token.text === "#"), "tokenizer should skip comments");

const ast = parseGapSource(sample);
assert.strictEqual(ast.type, "program", "parser should return a program node");
assert.deepStrictEqual(ast.errors, [], "parser should not report errors for the sample");
assert.strictEqual(ast.statements.length, 3, "top-level sample should contain assignment, function, and loop");

const [assignment, fn, loop] = ast.statements;
assert.strictEqual(assignment.type, "assignment", "first statement should be an assignment");
assert.strictEqual(assignment.name, "G", "assignment should preserve the left-hand name");
assert.strictEqual(assignment.expression.text, "SymmetricGroup(4)", "assignment should preserve expression text");

assert.strictEqual(fn.type, "functionAssignment", "second statement should be a function assignment");
assert.strictEqual(fn.name, "f", "function assignment should preserve the function name");
assert.deepStrictEqual(fn.params.map((param) => param.name), ["n"], "function parameters should be parsed");
assert(fn.body.some((statement) => statement.type === "localDeclaration"), "function body should include local declarations");
assert(fn.body.some((statement) => statement.type === "assignment" && statement.name === "values"), "function body should include assignments");

const ifStatement = fn.body.find((statement) => statement.type === "ifStatement");
assert(ifStatement, "function body should include the if statement");
assert.strictEqual(ifStatement.branches[0].condition.text, "IsList(values)", "if condition should be preserved");
assert.strictEqual(ifStatement.branches[0].body[0].type, "returnStatement", "then body should include a return");
assert.strictEqual(ifStatement.elseBody[0].expression.text, "[]", "else return expression should be preserved");

assert.strictEqual(loop.type, "forStatement", "third statement should parse as a for loop");
assert.strictEqual(loop.variable.text, "x", "for loop variable expression should be preserved");
assert.strictEqual(loop.iterator.text, "[1 .. 3]", "for loop iterator expression should be preserved");
assert.strictEqual(loop.body[0].type, "assignment", "for loop body should parse statements");

console.log("Parser tests passed.");
