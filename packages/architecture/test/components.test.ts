/**
 * Which box a span is drawn in comes from its symbol's segments, never from splitting text: a Go
 * module path holds a dot inside one segment.
 */
import { describe, expect, test } from "vitest";

import { CodeSymbol, FunctionInfo, Phase, Role, Span, SymbolKind } from "@runshape/trace";
import { componentOf } from "../src";

describe("components are named from segments", () => {
  // A Go package: module "example.com/shop", package "orders". Its first segment holds a dot,
  // so any code that rebuilt the name by splitting "example.com.shop.orders" would see four
  // segments where the recorder sent three.
  const GO_PACKAGE = ["example.com", "shop", "orders"];
  const spanOf = (symbol: CodeSymbol) => {
    const fn: FunctionInfo = { role: Role.Source, symbol, file: "orders/service.go", firstLine: 1, landmarkKind: null };
    return new Span(1, fn, null, null, Phase.Call, 0, 1);
  };

  test("a method's box is its type; a free function's box is its package, labelled by its last two segments", () => {
    const method = componentOf(spanOf(new CodeSymbol(GO_PACKAGE, ["Service"], "Place", SymbolKind.Method, "Service")));
    const free = componentOf(spanOf(new CodeSymbol(GO_PACKAGE.slice(0, 2), [], "Handle", SymbolKind.Function, null)));

    // Ids use Runshape's dotted syntax, where a dot inside a segment is escaped, so
    // "example.com"+"shop" and "example"+"com.shop" can't share a box.
    expect([method, free].map(({ id, kind, label, name }) => ({ id, kind, label, segments: name?.segments }))).toEqual([
      { id: "class:example\\.com.shop.orders.Service", kind: "class", label: "Service", segments: [...GO_PACKAGE, "Service"] },
      // Split text would have labelled this "com.shop".
      { id: "module:example\\.com.shop", kind: "module", label: "example.com.shop", segments: ["example.com", "shop"] },
    ]);
  });
});
