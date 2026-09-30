import ts from 'typescript';
import { readUtilityColors } from './foreground-contrast.mjs';

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
