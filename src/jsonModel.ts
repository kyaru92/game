import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { applyEdits, modify, parse, printParseErrorCode, ParseError } from "jsonc-parser";

export type JsonObject = Record<string, any>;

export interface ParseResult<T = JsonObject> {
  value: T;
  errors: ParseError[];
}

export function parseJsoncModel<T = JsonObject>(model: monaco.editor.ITextModel): ParseResult<T> {
  const errors: ParseError[] = [];
  const value = parse(model.getValue(), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as T;
  return { value: value ?? ({} as T), errors };
}

export function parseErrorText(error: ParseError): string {
  return `${printParseErrorCode(error.error)} @ ${error.offset}`;
}

export function setJsonValue(
  model: monaco.editor.ITextModel,
  path: Array<string | number>,
  value: unknown,
): void {
  const text = model.getValue();
  const edits = modify(text, path, value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 4,
      eol: "\n",
    },
  });
  if (!edits.length) return;
  model.pushEditOperations(
    [],
    edits.map((edit) => ({
      range: offsetRangeToMonacoRange(model, edit.offset, edit.length),
      text: edit.content,
    })),
    () => null,
  );
}

export function formatAsJsonc(value: unknown): string {
  return JSON.stringify(value, null, 4) + "\n";
}

export function rewriteModel(model: monaco.editor.ITextModel, value: unknown): void {
  model.setValue(formatAsJsonc(value));
}

function offsetRangeToMonacoRange(
  model: monaco.editor.ITextModel,
  offset: number,
  length: number,
): monaco.IRange {
  const start = model.getPositionAt(offset);
  const end = model.getPositionAt(offset + length);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}
