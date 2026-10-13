"""Renders a recorded scenario as an indented call tree so tests can assert on the whole
recording at once, in a form a reader can check by eye.

    place_order @OrderService#1          a span; @Class#n is the receiving object
      + new Order#2                      an object created in this span
      ~ OrderService#1.repository -> ... a wire found when __init__ finished
      => postgres: fakedb.FakeDb.execute a call leaving the process
      <= GET /api/articles               the request a landmark span received
"""
from typing import Dict, List, Optional, Union

Item = Union[str, int]  # a note line, or a child span id


def call_tree(scenario: dict, phase: str = "call", show_lines: bool = False) -> str:
    functions = scenario["functions"]
    current_phase: Optional[str] = None
    spans: Dict[int, dict] = {}
    items: Dict[Optional[int], List[Item]] = {None: []}
    classes: Dict[int, str] = {}
    created_in: Dict[int, Optional[int]] = {}

    def owner(span: Optional[int]) -> Optional[int]:
        return span if span in spans else None

    for event in scenario["events"]:
        kind = event[0]
        if kind == "P":
            current_phase = event[2]
        elif kind == "S" and current_phase == phase:
            _, _, span, function, parent, _, obj = event
            spans[span] = {"function": function, "obj": obj, "resumes": 0, "lines": []}
            items[span] = []
            items[owner(parent)].append(span)
        elif kind == "R" and event[2] in spans:
            spans[event[2]]["resumes"] += 1
        elif kind == "L" and event[1] in spans:
            spans[event[1]]["lines"].append(event[2])
        elif kind == "O":
            _, _, obj, cls, span = event
            classes[obj] = cls.rsplit(".", 1)[-1]
            created_in[obj] = owner(span)
            if span in spans:
                items[span].append(f"+ new {classes[obj]}#{obj}")
            elif current_phase == phase:
                items[None].append(f"+ found {classes[obj]}#{obj} (built before this phase)")
        elif kind == "W" and current_phase == phase:
            _, _, obj, attribute, target = event
            text = f"~ {classes.get(obj)}#{obj}.{attribute} -> {classes.get(target)}#{target}"
            items[created_in.get(obj)].append(text)
        elif kind == "B" and current_phase == phase:
            _, _, span, system, operation, statement = event
            items[owner(span)].append(f"=> {system}: {operation}({statement!r})")
        elif kind == "Q" and event[2] in spans:
            items[event[2]].append(f"<= {event[3]} {event[4]}")

    out: List[str] = []

    def render(entries: List[Item], depth: int) -> None:
        for entry in entries:
            if isinstance(entry, str):
                out.append("  " * depth + entry)
                continue
            info = spans[entry]
            label = functions[info["function"]]["qualname"]
            if info["obj"] is not None:
                label += f" @{classes.get(info['obj'])}#{info['obj']}"
            if info["resumes"]:
                label += f" (resumed x{info['resumes']})"
            if show_lines:
                label += f" lines={info['lines']}"
            out.append("  " * depth + label)
            render(items[entry], depth + 1)

    render(items[None], 0)
    return "\n".join(out)
