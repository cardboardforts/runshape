import { CodeSymbol, SymbolKind } from "./trace";

/** A function as views hand it to the UI: the key to ask for it by, and names to show. */
export interface FunctionRef {
  /** CodeSymbol.key: a request names the function by sending this back. */
  key: string;
  /** Its namespace in Runshape's dotted syntax: "app.services.articles". */
  namespace: string;
  /** Its name within the namespace: "ArticlesRepository.get_article_by_slug". */
  path: string;
  kind: SymbolKind;
}

export function functionRef(symbol: CodeSymbol): FunctionRef {
  return { key: symbol.key, namespace: symbol.namespaceName.text, path: symbol.localName.text, kind: symbol.kind };
}
