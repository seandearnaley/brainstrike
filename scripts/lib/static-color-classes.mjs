import ts from 'typescript';
import { readUtilityColors } from './foreground-contrast.mjs';

function jsxPaint(element, file) {
  const attributes = element.attributes.properties;
  const classes = attributes.filter(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'className'
  );
  const initializer = classes[0]?.initializer;
  const value =
    initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  const isLiteral = value && ts.isStringLiteralLike(value);
  return {
    element: element.tagName.getText(file),
    literal: isLiteral ? value.text : '',
    unresolved:
      classes.length > 1 ||
      (classes.length > 0 && !isLiteral) ||
      attributes.some(
        (attribute) =>
          ts.isJsxSpreadAttribute(attribute) ||
          (ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'style')
      ),
  };
}

// Only a literal className owns paint. Do not attach title strings, prose,
// reusable constants or dynamic class fragments to a coincidental ancestor.
function jsxPaintPath(node, file) {
  const initializer = ts.isJsxExpression(node.parent) ? node.parent : node;
  const attribute = initializer.parent;
  if (!(ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'className')) {
    return [];
  }
  const opening = attribute.parent.parent;
  if (!(ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))) {
    return [];
  }
  const path = [];
  let element = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  while (ts.isJsxElement(element) || ts.isJsxSelfClosingElement(element)) {
    path.push(jsxPaint(ts.isJsxElement(element) ? element.openingElement : element, file));
    element = element.parent;
    // Fragments preserve direct JSX ancestry. Expressions/functions/components
    // may mount elsewhere, so they cannot establish a measured ancestor surface.
    while (ts.isJsxFragment(element)) {
      element = element.parent;
    }
  }
  return path;
}

/** Inspect complete static string tokens; never regex across comments or JSX prose. */
export function staticClassStrings(source, path = 'component.tsx') {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length > 0) {
    throw new Error(
      `Cannot parse ${path}: ${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, '\n')}`
    );
  }
  const result = [];
  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // The full-source guard consumes this metadata to qualify exact
      // aria-hidden decorative exceptions (source-foreground-contract.mjs).
      let element = node.parent;
      while (element && !ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
        element = element.parent;
      }
      const ariaHidden =
        element?.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(file) === 'aria-hidden' &&
            attribute.initializer &&
            ts.isStringLiteral(attribute.initializer) &&
            attribute.initializer.text === 'true'
        ) ?? false;
      // A token touching ${...} is runtime-composed, not a complete utility.
      let literal = node.text;
      if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        literal = literal.replace(/^\S+/, '');
      }
      if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
        literal = literal.replace(/\S+$/, '');
      }
      result.push({
        ariaHidden,
        element: element?.tagName.getText(file),
        jsxPath: jsxPaintPath(node, file),
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        literal,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

export function staticColorClasses(source, path = 'component.tsx') {
  return staticClassStrings(source, path).flatMap(({ literal, line }) =>
    readUtilityColors(literal).map((paint) => ({ ...paint, line, literal }))
  );
}
