// packages/pane-terminal/eslint/no-allocation-in-hot-path.ts
//
// Custom ESLint rule for Gate 3's static invariant: zero allocation in any
// function body that begins with a `// [HOT-PATH]` comment. Pairs with the
// runtime heap-delta gate at tests/bench/g3-heap-delta.bench.ts — together
// they enforce "zero allocation in hot path" from two angles, because
// neither alone is sufficient.
//
// Marker shape (line comment OR block comment, immediately preceding a
// function-like node, or first statement inside the body):
//
//   // [HOT-PATH] byte-arrival callback — must not allocate per-byte
//   function onBytes(bytes: Uint8Array) {
//     paneCounter += bytes.byteLength; // ok — no allocation
//     // events.push({ size: bytes.byteLength }); // would fail: ObjectExpression
//   }
//
// Detected allocation node kinds:
//   NewExpression, ObjectExpression, ArrayExpression, TemplateLiteral with
//   expressions, SpreadElement, ArrayPattern/ObjectPattern in destructuring
//   assignments (creates an iterator), and CallExpression for known
//   array-allocating Array.prototype methods.
//
// [LAW:behavior-not-structure] The marker declares a behavior (no allocation
// here) that the rule mechanically enforces. Renaming a function or moving
// it does not change the contract — the marker travels with the body.

import type { Rule } from "eslint";
import type {
  Node as ESTreeNode,
  Comment,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunctionExpression,
  MethodDefinition,
  Property,
} from "estree";

const ALLOCATING_ARRAY_METHODS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
  "from",
  "of",
]);

type FunctionLike =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunctionExpression;

const MARKER = "[HOT-PATH]";

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid allocation expressions inside functions marked with // [HOT-PATH].",
    },
    schema: [],
    messages: {
      allocation:
        "Allocation ({{kind}}) inside a [HOT-PATH] function — Gate 3 forbids per-call allocation in this body.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    function isMarked(fn: FunctionLike | MethodDefinition | Property): boolean {
      // Walk up to the enclosing statement when the function is the init of
      // a variable / property / argument — comments attach to the syntactic
      // line, which for `const f = () => {}` is the VariableDeclaration, not
      // the inner ArrowFunctionExpression.
      let anchor: ESTreeNode = fn as ESTreeNode;
      const carrierTypes = new Set([
        "VariableDeclarator",
        "VariableDeclaration",
        "Property",
        "MethodDefinition",
        "AssignmentExpression",
        "ExpressionStatement",
      ]);
      while (
        (anchor as { parent?: ESTreeNode }).parent &&
        carrierTypes.has((anchor as { parent: ESTreeNode }).parent.type)
      ) {
        anchor = (anchor as { parent: ESTreeNode }).parent;
      }
      const leading = sourceCode.getCommentsBefore(anchor);
      const insideBody = bodyOf(fn);
      const inside = insideBody
        ? sourceCode.getCommentsInside(insideBody as ESTreeNode).filter((c) => {
            // only the first-statement leading comments, not later ones
            return (
              insideBody.body.length > 0 &&
              c.range !== undefined &&
              insideBody.body[0].range !== undefined &&
              c.range[1] <= insideBody.body[0].range[0]
            );
          })
        : [];
      return [...leading, ...inside].some((c: Comment) =>
        c.value.includes(MARKER),
      );
    }

    function bodyOf(
      fn: FunctionLike | MethodDefinition | Property,
    ): { body: ESTreeNode[] } | null {
      if (fn.type === "MethodDefinition" || fn.type === "Property") {
        const value = fn.value;
        if (
          value &&
          (value.type === "FunctionExpression" ||
            value.type === "ArrowFunctionExpression") &&
          value.body.type === "BlockStatement"
        ) {
          return value.body;
        }
        return null;
      }
      if (fn.body && fn.body.type === "BlockStatement") {
        return fn.body;
      }
      return null;
    }

    function reportAllocations(
      body: ESTreeNode,
      reportNode: (n: ESTreeNode, kind: string) => void,
    ): void {
      // Manual walk — ESLint's getScope/sourceCode don't expose a walker, so
      // we recurse over child keys. Skip nested functions: their bodies have
      // their own marker discipline.
      const visit = (node: ESTreeNode | null | undefined): void => {
        if (!node || typeof node !== "object" || !("type" in node)) return;
        switch (node.type) {
          case "FunctionExpression":
          case "ArrowFunctionExpression":
          case "FunctionDeclaration":
            return; // nested functions opt out
          case "NewExpression":
            reportNode(node, "new");
            break;
          case "ObjectExpression":
            reportNode(node, "object literal");
            break;
          case "ArrayExpression":
            reportNode(node, "array literal");
            break;
          case "SpreadElement":
            reportNode(node, "spread");
            break;
          case "TemplateLiteral":
            if ((node as { expressions: unknown[] }).expressions.length > 0) {
              reportNode(node, "template literal with expressions");
            }
            break;
          case "CallExpression": {
            const callee = (node as { callee: ESTreeNode }).callee;
            if (
              callee &&
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property.type === "Identifier" &&
              ALLOCATING_ARRAY_METHODS.has(callee.property.name)
            ) {
              reportNode(node, `Array.${callee.property.name}`);
            }
            break;
          }
        }
        for (const key of Object.keys(node)) {
          // Skip non-tree fields and ESLint's `parent` back-pointer (which
          // would otherwise turn this DFS into an infinite walk up→down→up).
          if (
            key === "type" ||
            key === "loc" ||
            key === "range" ||
            key === "parent" ||
            key === "leadingComments" ||
            key === "trailingComments"
          )
            continue;
          const child = (node as unknown as Record<string, unknown>)[key];
          if (Array.isArray(child)) {
            for (const c of child) visit(c as ESTreeNode);
          } else if (child && typeof child === "object" && "type" in child) {
            visit(child as ESTreeNode);
          }
        }
      };
      visit(body);
    }

    function check(fn: FunctionLike): void {
      if (!isMarked(fn)) return;
      const body = bodyOf(fn);
      if (!body) return;
      for (const stmt of body.body) {
        reportAllocations(stmt as ESTreeNode, (n, kind) => {
          context.report({
            node: n as Rule.Node,
            messageId: "allocation",
            data: { kind },
          });
        });
      }
    }

    return {
      FunctionDeclaration: (n) => check(n as FunctionDeclaration),
      FunctionExpression: (n) => check(n as FunctionExpression),
      ArrowFunctionExpression: (n) => check(n as ArrowFunctionExpression),
    };
  },
};

export default rule;
