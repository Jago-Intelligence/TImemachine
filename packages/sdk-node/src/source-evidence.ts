import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  sourceAccessSchema,
  normalizePostgresQuery,
  type Failure,
  type HttpRecording,
  type SourceAccess,
} from '@timemachine/core';

function nodes<T extends ts.Node>(
  root: ts.Node,
  match: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}
function assignment(node: ts.BinaryExpression) {
  return (
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}
function one<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}
function contains(node: ts.Node, position: number, source: ts.SourceFile) {
  return node.getStart(source) <= position && node.getEnd() > position;
}
function getRequest(call: ts.CallExpression) {
  if (call.arguments.length === 1) return true;
  if (call.arguments.length !== 2) return false;
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.every(
    (part) =>
      ts.isPropertyAssignment(part) &&
      ts.isIdentifier(part.name) &&
      (part.name.text === 'signal' ||
        (part.name.text === 'method' &&
          ts.isStringLiteral(part.initializer) &&
          part.initializer.text === 'GET')),
  );
}
function declaration(source: ts.SourceFile, name: string) {
  return one(
    nodes(source, ts.isVariableDeclaration).filter((node) =>
      ts.isIdentifier(node.name)
        ? node.name.text === name
        : ts.isObjectBindingPattern(node.name) &&
          node.name.elements.some(
            (part) => ts.isIdentifier(part.name) && part.name.text === name,
          ),
    ),
  );
}
function constant(
  node: ts.VariableDeclaration | undefined,
): node is ts.VariableDeclaration {
  return (
    !!node &&
    ts.isVariableDeclarationList(node.parent) &&
    !!(node.parent.flags & ts.NodeFlags.Const)
  );
}
function block(node: ts.Node): ts.Node | undefined {
  let parent = node.parent;
  while (parent && !ts.isBlock(parent) && !ts.isSourceFile(parent))
    parent = parent.parent;
  return parent;
}
function inlineHttpBinding(
  source: ts.SourceFile,
  call: ts.CallExpression,
  receiver: string,
  dataMember: boolean,
  recording: HttpRecording,
) {
  const bound = declaration(source, receiver);
  if (
    !constant(bound) ||
    bound.getEnd() > call.getStart(source) ||
    block(bound) !== block(call)
  )
    return;
  let result = bound;
  if (
    !bound.initializer ||
    !ts.isAwaitExpression(bound.initializer) ||
    !ts.isCallExpression(bound.initializer.expression)
  )
    return;
  const initialCall = bound.initializer.expression;
  const json =
    ts.isPropertyAccessExpression(initialCall.expression) &&
    initialCall.expression.name.text === 'json';
  if (json) {
    if (
      dataMember ||
      !ts.isIdentifier(bound.name) ||
      !ts.isPropertyAccessExpression(initialCall.expression) ||
      !ts.isIdentifier(initialCall.expression.expression)
    )
      return;
    const response = declaration(source, initialCall.expression.expression.text);
    if (
      !constant(response) ||
      response.getEnd() > bound.getStart(source) ||
      block(response) !== block(bound)
    )
      return;
    result = response;
  } else if (!dataMember) {
    if (
      !ts.isObjectBindingPattern(bound.name) ||
      !bound.name.elements.some(
        (part) =>
          !part.dotDotDotToken &&
          !part.initializer &&
          ts.isIdentifier(part.name) &&
          part.name.text === receiver &&
          (part.propertyName
            ? ts.isIdentifier(part.propertyName) && part.propertyName.text === 'data'
            : receiver === 'data'),
      )
    )
      return;
  }
  const names = [receiver, ...(ts.isIdentifier(result.name) ? [result.name.text] : [])];
  function objectReference(node: ts.Node): boolean {
    return (
      (ts.isIdentifier(node) && names.includes(node.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === 'data' &&
        ts.isIdentifier(node.expression) &&
        names.includes(node.expression.text)) ||
      ((ts.isObjectLiteralExpression(node) ||
        ts.isArrayLiteralExpression(node) ||
        ts.isSpreadElement(node)) &&
        nodes(node, ts.isIdentifier).some((id) => names.includes(id.text)))
    );
  }
  // Reject writes, aliases, escapes into other calls and parameter shadowing.
  if (
    nodes(source, ts.isBinaryExpression).some(
      (node) =>
        assignment(node) &&
        nodes(node.left, ts.isIdentifier).some((id) => names.includes(id.text)),
    ) ||
    nodes(source, ts.isParameter).some(
      (node) => ts.isIdentifier(node.name) && names.includes(node.name.text),
    ) ||
    nodes(source, ts.isVariableDeclaration).some(
      (node) =>
        node !== bound &&
        node !== result &&
        node.initializer &&
        objectReference(node.initializer),
    ) ||
    nodes(source, ts.isCallExpression).some((node) =>
      node.arguments.some(objectReference),
    ) ||
    nodes(source, ts.isDeleteExpression).some((node) =>
      nodes(node.expression, ts.isIdentifier).some((id) => names.includes(id.text)),
    ) ||
    nodes(source, ts.isPrefixUnaryExpression).some(
      (node) =>
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
          node.operator,
        ) && nodes(node.operand, ts.isIdentifier).some((id) => names.includes(id.text)),
    ) ||
    nodes(source, ts.isPostfixUnaryExpression).some((node) =>
      nodes(node.operand, ts.isIdentifier).some((id) => names.includes(id.text)),
    )
  )
    return;
  const awaited = result.initializer;
  if (
    !awaited ||
    !ts.isAwaitExpression(awaited) ||
    !ts.isCallExpression(awaited.expression)
  )
    return;
  const request = awaited.expression;
  const method = request.expression;
  const literal = request.arguments[0];
  if (!literal || !ts.isStringLiteral(literal)) return;
  let target = literal.text;
  if (json) {
    if (!getRequest(request)) return;
    const native =
      (ts.isIdentifier(method) && method.text === 'fetch') ||
      (ts.isPropertyAccessExpression(method) &&
        ts.isIdentifier(method.expression) &&
        method.expression.text === 'globalThis' &&
        method.name.text === 'fetch');
    if (
      !native ||
      declaration(source, 'fetch') ||
      declaration(source, 'globalThis') ||
      nodes(source, ts.isFunctionDeclaration).some(
        (node) => node.name && ['fetch', 'globalThis'].includes(node.name.text),
      ) ||
      nodes(source, ts.isImportSpecifier).some((node) =>
        ['fetch', 'globalThis'].includes(node.name.text),
      ) ||
      nodes(source, ts.isImportClause).some(
        (node) => node.name && ['fetch', 'globalThis'].includes(node.name.text),
      ) ||
      nodes(source, ts.isVariableDeclaration).some(
        (node) =>
          ts.isIdentifier(node.name) && ['fetch', 'globalThis'].includes(node.name.text),
      ) ||
      nodes(source, ts.isParameter).some(
        (node) =>
          ts.isIdentifier(node.name) && ['fetch', 'globalThis'].includes(node.name.text),
      )
    )
      return;
  } else {
    if (
      !ts.isPropertyAccessExpression(method) ||
      method.name.text !== 'get' ||
      !ts.isIdentifier(method.expression) ||
      request.arguments.length !== 1
    )
      return;
    let client = method.expression.text;
    const instance = declaration(source, client);
    if (instance) {
      if (
        !constant(instance) ||
        !instance.initializer ||
        !ts.isCallExpression(instance.initializer) ||
        !ts.isPropertyAccessExpression(instance.initializer.expression) ||
        instance.initializer.expression.name.text !== 'create' ||
        !ts.isIdentifier(instance.initializer.expression.expression)
      )
        return;
      client = instance.initializer.expression.expression.text;
      const options = instance.initializer.arguments[0];
      if (options) {
        if (
          !ts.isObjectLiteralExpression(options) ||
          options.properties.some(
            (part) =>
              !ts.isPropertyAssignment(part) ||
              !ts.isIdentifier(part.name) ||
              part.name.text !== 'baseURL',
          )
        )
          return;
        const base = one(
          options.properties
            .filter(ts.isPropertyAssignment)
            .filter((part) => ts.isIdentifier(part.name) && part.name.text === 'baseURL'),
        );
        if (base) {
          if (
            !ts.isStringLiteral(base.initializer) ||
            !target.startsWith('/') ||
            target.startsWith('//')
          )
            return;
          target = new URL(target, base.initializer.text).href;
        }
      }
    }
    const imported = nodes(source, ts.isImportDeclaration).some(
      (node) =>
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'axios' &&
        node.importClause?.name?.text === client,
    );
    const clientNames = [client, method.expression.text];
    if (
      !imported ||
      declaration(source, client) ||
      nodes(source, ts.isParameter).some(
        (node) => ts.isIdentifier(node.name) && clientNames.includes(node.name.text),
      ) ||
      nodes(source, ts.isBinaryExpression).some(
        (node) =>
          assignment(node) &&
          nodes(node.left, ts.isIdentifier).some((id) => clientNames.includes(id.text)),
      ) ||
      nodes(source, ts.isCallExpression).some((node) =>
        node.arguments.some(
          (arg) => ts.isIdentifier(arg) && clientNames.includes(arg.text),
        ),
      )
    )
      return;
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return;
  return one(
    recording.dependencies.filter(
      (row) =>
        row.origin === url.origin && row.route === url.pathname && row.method === 'GET',
    ),
  );
}

export function inspectSourceAccess(
  source: ts.SourceFile,
  frames: Failure['frames'],
  recording: HttpRecording,
): SourceAccess | undefined {
  const first = frames[0],
    caller = frames[1];
  if (!first) return;
  const lines = source.getLineStarts();
  if (lines[first.line - 1] === undefined) return;
  const position = lines[first.line - 1]! + Math.max(0, (first.column ?? 1) - 1);
  if (position >= (lines[first.line] ?? source.text.length)) return;
  const call = one(
    nodes(source, ts.isCallExpression).filter(
      (node) =>
        contains(node, position, source) &&
        !(node.flags & ts.NodeFlags.OptionalChain) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['toFixed', 'trim', 'toLowerCase', 'toUpperCase'].includes(
          node.expression.name.text,
        ) &&
        (ts.isElementAccessExpression(node.expression.expression) ||
          ts.isPropertyAccessExpression(node.expression.expression)),
    ),
  );
  if (
    !call ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !(
      ts.isElementAccessExpression(call.expression.expression) ||
      ts.isPropertyAccessExpression(call.expression.expression)
    )
  )
    return;
  const access = call.expression.expression;
  const base = access.expression;
  const dataMember =
    ts.isPropertyAccessExpression(base) &&
    base.name.text === 'data' &&
    ts.isIdentifier(base.expression);
  if (!ts.isIdentifier(base) && !dataMember) return;
  const receiver = ts.isIdentifier(base)
    ? base.text
    : (base.expression as ts.Identifier).text;
  const operation = call.expression.name.text;
  let field: string | undefined;
  if (ts.isPropertyAccessExpression(access)) field = access.name.text;
  else if (ts.isStringLiteral(access.argumentExpression))
    field = access.argumentExpression.text;
  else if (ts.isIdentifier(access.argumentExpression)) {
    const name = access.argumentExpression.text;
    const declaration = one(
      nodes(source, ts.isVariableDeclaration).filter(
        (node) => ts.isIdentifier(node.name) && node.name.text === name,
      ),
    );
    if (
      !declaration?.initializer ||
      !ts.isStringLiteral(declaration.initializer) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return;
    // Reject reassignment or shadowing of the lookup identifier.
    if (
      nodes(source, ts.isBinaryExpression).some(
        (node) =>
          assignment(node) && ts.isIdentifier(node.left) && node.left.text === name,
      )
    )
      return;
    field = declaration.initializer.text;
  }
  if (!field) return;
  const inline = inlineHttpBinding(source, call, receiver, dataMember, recording);
  if (inline) {
    const parsed = sourceAccessSchema.safeParse({
      file: first.file,
      line: first.line,
      ...(first.column ? { column: first.column } : {}),
      sourceHash: createHash('sha256').update(source.text).digest('hex'),
      field,
      operation,
      receiver: dataMember ? `${receiver}.data` : receiver,
      dependencyId: inline.id,
      dependencyType: 'http',
    });
    return parsed.success ? parsed.data : undefined;
  }
  if (dataMember) return;
  // Narrow inline pg flow: const result = await database.query(SQL, ...);
  // const row = result.rows[0]; row[FIELD].toFixed(...).
  const row = one(
    nodes(source, ts.isVariableDeclaration).filter(
      (node) => ts.isIdentifier(node.name) && node.name.text === receiver,
    ),
  );
  const initializer = row?.initializer;
  if (
    initializer &&
    ts.isElementAccessExpression(initializer) &&
    ts.isNumericLiteral(initializer.argumentExpression) &&
    initializer.argumentExpression.text === '0' &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    initializer.expression.name.text === 'rows' &&
    ts.isIdentifier(initializer.expression.expression)
  ) {
    const resultName = initializer.expression.expression.text;
    const result = one(
      nodes(source, ts.isVariableDeclaration).filter(
        (node) => ts.isIdentifier(node.name) && node.name.text === resultName,
      ),
    );
    const awaited = result?.initializer;
    if (
      !row ||
      !result ||
      !ts.isVariableDeclarationList(row.parent) ||
      !ts.isVariableDeclarationList(result.parent) ||
      !(row.parent.flags & ts.NodeFlags.Const) ||
      !(result.parent.flags & ts.NodeFlags.Const)
    )
      return;
    // Both declarations must be in the same block and precede the failure.
    if (
      row.parent.parent.parent !== result.parent.parent.parent ||
      result.getEnd() > row.getStart(source) ||
      row.getEnd() > position
    )
      return;
    if (
      nodes(source, ts.isBinaryExpression).some(
        (node) =>
          assignment(node) &&
          nodes(node.left, ts.isIdentifier).some((id) =>
            [receiver, resultName].includes(id.text),
          ),
      )
    )
      return;
    if (
      !awaited ||
      !ts.isAwaitExpression(awaited) ||
      !ts.isCallExpression(awaited.expression) ||
      !ts.isPropertyAccessExpression(awaited.expression.expression) ||
      awaited.expression.expression.name.text !== 'query'
    )
      return;
    const sqlArg = awaited.expression.arguments[0];
    let sql: string | undefined;
    if (sqlArg && ts.isStringLiteral(sqlArg)) sql = sqlArg.text;
    else if (sqlArg && ts.isIdentifier(sqlArg)) {
      const declaration = one(
        nodes(source, ts.isVariableDeclaration).filter(
          (node) => ts.isIdentifier(node.name) && node.name.text === sqlArg.text,
        ),
      );
      if (
        declaration?.initializer &&
        ts.isStringLiteral(declaration.initializer) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        !nodes(source, ts.isBinaryExpression).some(
          (node) =>
            assignment(node) &&
            ts.isIdentifier(node.left) &&
            node.left.text === sqlArg.text,
        )
      )
        sql = declaration.initializer.text;
    }
    const normalized = sql && normalizePostgresQuery(sql);
    if (!normalized) return;
    const hash = createHash('sha256').update(normalized).digest('hex');
    const dependency = one(
      (recording.postgres ?? []).filter((record) => record.queryHash === hash),
    );
    if (!dependency) return;
    const parsed = sourceAccessSchema.safeParse({
      file: first.file,
      line: first.line,
      ...(first.column ? { column: first.column } : {}),
      sourceHash: createHash('sha256').update(source.text).digest('hex'),
      field,
      operation,
      receiver,
      dependencyId: dependency.id,
      dependencyType: 'postgres',
    });
    return parsed.success ? parsed.data : undefined;
  }
  if (!caller || first.file !== caller.file || lines[caller.line - 1] === undefined)
    return;
  const fn = one(
    nodes(source, ts.isFunctionDeclaration).filter(
      (node) =>
        contains(node, position, source) &&
        node.name &&
        node.parameters[0] &&
        ts.isIdentifier(node.parameters[0].name) &&
        node.parameters[0].name.text === receiver,
    ),
  );
  if (!fn?.name) return;
  if (
    nodes(fn, ts.isBinaryExpression).some(
      (node) =>
        assignment(node) &&
        ((ts.isIdentifier(node.left) && node.left.text === receiver) ||
          ((ts.isPropertyAccessExpression(node.left) ||
            ts.isElementAccessExpression(node.left)) &&
            ts.isIdentifier(node.left.expression) &&
            node.left.expression.text === receiver)),
    )
  )
    return;
  const callerPosition = lines[caller.line - 1]! + Math.max(0, (caller.column ?? 1) - 1);
  const invocation = one(
    nodes(source, ts.isCallExpression).filter(
      (node) =>
        contains(node, callerPosition, source) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === fn.name!.text,
    ),
  );
  const argument = invocation?.arguments[0];
  if (
    !argument ||
    !ts.isAwaitExpression(argument) ||
    !ts.isCallExpression(argument.expression) ||
    !ts.isPropertyAccessExpression(argument.expression.expression) ||
    argument.expression.expression.name.text !== 'json' ||
    !ts.isIdentifier(argument.expression.expression.expression)
  )
    return;
  const resultName = argument.expression.expression.expression.text;
  const result = one(
    nodes(source, ts.isVariableDeclaration).filter(
      (node) => ts.isIdentifier(node.name) && node.name.text === resultName,
    ),
  );
  if (
    nodes(source, ts.isBinaryExpression).some(
      (node) =>
        assignment(node) && ts.isIdentifier(node.left) && node.left.text === resultName,
    )
  )
    return;
  const awaited = result?.initializer;
  if (
    !awaited ||
    !ts.isAwaitExpression(awaited) ||
    !ts.isCallExpression(awaited.expression)
  )
    return;
  const fetchCall = awaited.expression;
  if (
    !ts.isPropertyAccessExpression(fetchCall.expression) ||
    !ts.isIdentifier(fetchCall.expression.expression) ||
    fetchCall.expression.expression.text !== 'globalThis' ||
    fetchCall.expression.name.text !== 'fetch' ||
    !fetchCall.arguments[0] ||
    !ts.isStringLiteral(fetchCall.arguments[0]) ||
    !getRequest(fetchCall)
  )
    return;
  const url = new URL(fetchCall.arguments[0].text);
  if (url.search || url.hash || url.username || url.password) return;
  const dependency = one(
    recording.dependencies.filter(
      (row) =>
        row.origin === url.origin && row.route === url.pathname && row.method === 'GET',
    ),
  );
  if (!dependency) return;
  const parsed = sourceAccessSchema.safeParse({
    file: first.file,
    line: first.line,
    ...(first.column ? { column: first.column } : {}),
    sourceHash: createHash('sha256').update(source.text).digest('hex'),
    field,
    operation,
    receiver,
    dependencyId: dependency.id,
  });
  return parsed.success ? parsed.data : undefined;
}

/** Snapshot explicitly approved source at SDK startup; never read latest source on the dashboard. */
export function createSourceInspector(root: string | undefined, files: string[] = []) {
  const sources = new Map<string, ts.SourceFile>();
  if (root)
    for (const file of files) {
      try {
        const base = realpathSync(root);
        const path = realpathSync(resolve(base, file));
        const relativePath = relative(base, path);
        if (
          isAbsolute(relativePath) ||
          relativePath.startsWith('..') ||
          statSync(path).size > 131072
        )
          continue;
        const text = readFileSync(path, 'utf8');
        sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
      } catch {
        /* Missing or unsafe source produces no evidence. */
      }
    }
  return (
    frames: Failure['frames'],
    recording?: HttpRecording,
  ): SourceAccess | undefined => {
    try {
      const source = frames[0] ? sources.get(frames[0].file) : undefined;
      return source && recording
        ? inspectSourceAccess(source, frames, recording)
        : undefined;
    } catch {
      return;
    }
  };
}
