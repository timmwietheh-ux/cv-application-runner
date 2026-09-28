"""Command line for the application register and its block documents.

  python scripts/cv.py list                       applications and documents
  python scripts/cv.py build <app> [doc ...]      render, typeset, export (all documents if none given)
  python scripts/cv.py build --all                every application
  python scripts/cv.py render <app> <doc>         write the generated LaTeX only
  python scripts/cv.py check [app]                TODO markers, character limits, broken documents
  python scripts/cv.py new <slug> --title "..." [--category phd] [--organization "..."]
                           [--deadline YYYY-MM-DD] [--cv template:academic-cv | --cv <app>/<doc>]
                           [--letter template:cover-letter] [--texts template:portal-texts]

Run it from anywhere; paths are resolved against the repository root.
Exit code 0 on success, 1 on problems.
"""
from __future__ import annotations

import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from cvkit import apps, build  # noqa: E402


def _documents(app, wanted):
    docs = app["documents"]
    if not wanted:
        return docs
    chosen = [doc for doc in docs if doc["id"] in wanted]
    missing = set(wanted) - {doc["id"] for doc in chosen}
    if missing:
        raise apps.AppError("%s has no document(s): %s" % (app["slug"], ", ".join(sorted(missing))))
    return chosen


def cmd_list(_args) -> int:
    listing = apps.list_applications(ROOT)
    labels = {item["id"]: item["label"] for item in listing["categories"]}
    for app in listing["applications"]:
        print("%-34s %-12s %-10s %s" % (app["slug"], app["status"], app.get("deadline") or "-",
                                        labels.get(app["category"], app["category"])))
        for doc in app["documents"]:
            print("    %-14s %-6s %s" % (doc["id"], doc["type"], doc.get("output") or doc.get("source") or doc.get("main")))
    for problem in listing["problems"]:
        print("PROBLEM:", problem)
    return 1 if listing["problems"] else 0


def cmd_build(args) -> int:
    listing = apps.list_applications(ROOT)
    targets = listing["applications"] if args.all else [apps.load_application(ROOT, args.app)]
    failures = 0
    for app in targets:
        for doc in _documents(app, [] if args.all else args.docs):
            label = "%s/%s" % (app["slug"], doc["id"])
            if doc["type"] == "texts":
                if doc.get("output"):
                    result = build.export_document(ROOT, doc)
                    note = " (over the limit: %s)" % ", ".join(result["overLimit"]) if result["overLimit"] else ""
                    print("wrote   %s%s" % (result["output"], note))
                continue
            print("build   %s" % label)
            completed = build.typeset(ROOT, doc, quiet=not args.verbose)
            if completed.returncode != 0:
                failures += 1
                print("FAILED  %s (latexmk exit %d); see %s/*.log" % (label, completed.returncode, doc["buildDir"]))
                if not args.verbose and completed.stdout:
                    print("\n".join(completed.stdout.splitlines()[-25:]))
                continue
            if doc.get("output") and not args.no_export:
                result = build.export_document(ROOT, doc)
                limit = " of %d allowed" % int(result["limit"]) if result.get("limit") else ""
                print("wrote   %s (%d bytes%s)" % (result["output"], result["bytes"], limit))
    return 1 if failures else 0


def cmd_render(args) -> int:
    doc = apps.find_document(ROOT, args.app, args.doc)
    result = build.render_document(ROOT, doc)
    print("%s %s" % ("wrote" if result.get("changed") else "unchanged", result.get("main")))
    for where in result.get("placeholders") or []:
        print("TODO marker in", where)
    return 0


def cmd_check(args) -> int:
    result = build.check_all(ROOT, args.app)
    if not result:
        print("No problems found.")
        return 0
    for where, problems in result.items():
        for problem in problems:
            print("%s: %s" % (where, problem))
    return 1


def cmd_new(args) -> int:
    app = apps.create_application(ROOT, args.slug, args.title, category=args.category,
                                  organization=args.organization, deadline=args.deadline,
                                  cv=args.cv, letter=args.letter, texts=args.texts)
    print("created %s with %s" % (app["folder"], ", ".join(doc["id"] for doc in app["documents"]) or "no documents"))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Applications and block documents of this CV workspace")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="list applications and documents").set_defaults(func=cmd_list)
    p_build = sub.add_parser("build", help="render, typeset and export")
    p_build.add_argument("app", nargs="?")
    p_build.add_argument("docs", nargs="*")
    p_build.add_argument("--all", action="store_true", help="every application")
    p_build.add_argument("--no-export", action="store_true", help="typeset only, do not copy to output/")
    p_build.add_argument("--verbose", action="store_true", help="show the full latexmk output")
    p_build.set_defaults(func=cmd_build)
    p_render = sub.add_parser("render", help="write the generated LaTeX of one document")
    p_render.add_argument("app")
    p_render.add_argument("doc")
    p_render.set_defaults(func=cmd_render)
    p_check = sub.add_parser("check", help="find TODO markers, limit overruns and broken documents")
    p_check.add_argument("app", nargs="?")
    p_check.set_defaults(func=cmd_check)
    p_new = sub.add_parser("new", help="create an application from templates or existing documents")
    p_new.add_argument("slug")
    p_new.add_argument("--title", required=True)
    p_new.add_argument("--category", default="general")
    p_new.add_argument("--organization", default="")
    p_new.add_argument("--deadline", default="")
    p_new.add_argument("--cv", default="template:academic-cv")
    p_new.add_argument("--letter", default="")
    p_new.add_argument("--texts", default="")
    p_new.set_defaults(func=cmd_new)
    args = parser.parse_args(argv)
    if args.command == "build" and not args.all and not args.app:
        parser.error("build needs an application or --all")
    try:
        return args.func(args)
    except (apps.AppError, ValueError, RuntimeError) as exc:
        print("ERROR:", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
