"""Tests for scripts/cvkit: markup, rendering, line maps, texts and the register."""
import json
import pathlib
import shutil
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from cvkit import apps, build, inline, model, render, texts  # noqa: E402

BS = chr(92)


class InlineTests(unittest.TestCase):
    def test_specials_are_escaped(self):
        out = inline.to_latex("R&D: 100% of #1_items ~ {x} \\ ^")
        for raw in ("&", "%", "#", "_", "{", "}"):
            self.assertIn(BS + raw, out)
        self.assertIn("textasciitilde", out)
        self.assertIn("textbackslash", out)
        self.assertIn("textasciicircum", out)

    def test_markup(self):
        out = inline.to_latex("**bold** and *italic* and [site](https://a.b/c#d) and `x_y` and $k^2$")
        self.assertIn(BS + "textbf{bold}", out)
        self.assertIn(BS + "emph{italic}", out)
        self.assertIn(BS + "href{https://a.b/c" + BS + "#d}{site}", out)
        self.assertIn(BS + "texttt{x" + BS + "_y}", out)
        self.assertIn("$k^2$", out)

    def test_placeholder_and_typography(self):
        out = inline.to_latex('[[TODO: name the group]] said "hi" 2024 - 2026...')
        self.assertIn(BS + "cvPlaceholder{name the group}", out)
        self.assertIn("“hi”", out)
        self.assertIn("2024 – 2026", out)
        self.assertIn("…", out)
        self.assertTrue(inline.has_placeholder("x [[TODO]] y"))

    def test_paragraphs_and_nbsp(self):
        out = inline.to_latex("one\ntwo\n\nthree four")
        self.assertEqual("one two" + BS + "par three~four", out)

    def test_facts(self):
        self.assertEqual(["a", "b", "c"], inline.split_facts("a | b · c"))
        self.assertIn(BS + "cvDot", inline.facts_to_latex("a|b"))


def _cv():
    return model.normalize({
        "kind": "cv",
        "header": {"headline": "Physics", "tagline": "A | B", "contacts": ["email"]},
        "sections": [
            {"id": "s1", "title": "Education", "blocks": [
                {"id": "e1", "type": "entry", "date": "2024 - now", "title": "M.Sc.", "org": "Uni",
                 "meta": "1.4 | 90 ECTS", "items": ["did A", "did B"]},
                {"id": "h1", "type": "text", "text": "hidden", "hidden": True},
            ]},
            {"id": "s2", "title": "Skills", "blocks": [
                {"id": "r1", "type": "rows", "rows": [{"label": "Code", "text": "Python | Julia"}]},
                {"id": "c1", "type": "cards", "cards": [{"title": "One", "items": ["x"]}, {"title": "Two", "items": []},
                                                     {"title": "Three", "items": ["y"]}]},
            ]},
        ],
    })


PROFILE = {"name": "Test Person", "contacts": {"email": {"icon": "envelope", "text": "t@x.org", "url": "mailto:t@x.org"}}}


class RenderTests(unittest.TestCase):
    def test_cv_renders_and_maps_lines(self):
        tex, tags = render.render(_cv(), PROFILE, source="apps/x/cv.json")
        lines = tex.splitlines()
        self.assertEqual(len(lines), len(tags))
        self.assertIn(BS + "cvHeader{Test Person}{Physics}{A " + BS + "cvDot B}{%", tex)
        self.assertNotIn("hidden", tex.replace("% hidden block h1", ""))
        item_line = next(i for i, line in enumerate(lines, 1) if line.startswith(BS + "item did B"))
        self.assertEqual({"section": "s1", "block": "e1", "field": "items.1", "line": item_line},
                         render.locate(tags, item_line))
        self.assertEqual(2, tex.count(BS + "cvCardRow"))
        first, last = render.block_lines(tags, "e1")
        self.assertLess(first, last)

    def test_unknown_contact_is_reported(self):
        doc = _cv()
        doc["header"]["contacts"] = ["fax"]
        with self.assertRaises(model.DocumentError):
            render.render(doc, PROFILE)

    def test_letter_with_linked_body(self):
        doc = model.normalize({"kind": "letter", "subject": "S", "salutation": "Dear all,",
                               "header": {"contacts": ["email"]}, "bodyFrom": "portal.json#m", "body": []})
        tex, _ = render.render(doc, PROFILE, resolver=lambda link: "First.\n\nSecond.")
        self.assertIn("First.", tex)
        self.assertIn("Second.", tex)
        self.assertIn(BS + "cvLetterSubject{S}", tex)
        with self.assertRaises(model.DocumentError):
            render.render(doc, PROFILE)

    def test_invalid_documents(self):
        with self.assertRaises(model.DocumentError):
            model.normalize({"kind": "poster"})
        with self.assertRaises(model.DocumentError):
            model.normalize({"kind": "cv", "sections": [{"blocks": [{"type": "nope"}]}]})


class TextTests(unittest.TestCase):
    def test_counts_follow_the_portal(self):
        counts = texts.count("ab\ncd – e")
        self.assertEqual(9, counts["chars"])
        self.assertEqual(9 + 1 + 2, counts["bytes"])  # CRLF and a three-byte dash

    def test_export_inserts_fields_at_marker(self):
        doc = model.normalize({"kind": "texts", "fields": [
            {"id": "m", "title": "Motivation", "limit": 10, "text": "12345678901"}]})
        sheet = texts.export_markdown(doc, "# Sheet\n\n" + texts.MARKER + "\n\nEnd\n")
        self.assertIn("## Motivation", sheet)
        self.assertIn("11 / 10", sheet)
        self.assertIn("Over the limit", sheet)
        self.assertTrue(sheet.rstrip().endswith("End"))
        self.assertEqual(["Motivation"], texts.over_limit(doc))


class RegisterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "applications" / "_templates", self.tmp / "applications" / "_templates")
        shutil.copyfile(ROOT / "applications" / "profile.json", self.tmp / "applications" / "profile.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_create_render_duplicate(self):
        app = apps.create_application(self.tmp, "phd-test", "PhD Test", category="phd", organization="Lab",
                                      deadline="2027-01-31", cv="template:academic-cv",
                                      letter="template:cover-letter", texts="template:portal-texts")
        self.assertEqual(["cv", "letter", "texts"], [doc["id"] for doc in app["documents"]])
        self.assertTrue(app["documents"][0]["output"].startswith("output/phd-test/John_Doe_"))
        cv = apps.find_document(self.tmp, "phd-test", "cv")
        result = build.render_document(self.tmp, cv)
        self.assertTrue((self.tmp / cv["main"]).is_file())
        self.assertTrue(result["changed"])
        self.assertFalse(build.render_document(self.tmp, cv)["changed"])
        letter = apps.find_document(self.tmp, "phd-test", "letter")
        self.assertTrue(any("TODO marker" in problem for problem in build.check_document(self.tmp, letter)))
        app = apps.duplicate_document(self.tmp, "phd-test", "cv", "cv-short", "Short CV")
        self.assertIn("cv-short", [doc["id"] for doc in app["documents"]])
        with self.assertRaises(apps.AppError):
            apps.create_application(self.tmp, "phd-test", "Again")
        with self.assertRaises(apps.AppError):
            apps.create_application(self.tmp, "Bad Slug", "x")

    def test_update_application(self):
        apps.create_application(self.tmp, "job-a", "Job A", category="industry", cv="template:industry-cv")
        app = apps.update_application(self.tmp, "job-a", {"status": "submitted", "checklist": [
            {"text": "Send", "done": True}, {"text": "  "}]})
        self.assertEqual("submitted", app["status"])
        self.assertEqual([{"text": "Send", "done": True}], app["checklist"])
        with self.assertRaises(apps.AppError):
            apps.update_application(self.tmp, "job-a", {"documents": []})


class RepositoryDocumentsTests(unittest.TestCase):
    """Every real document in the repository must at least render."""

    def test_all_documents_render(self):
        listing = apps.list_applications(ROOT)
        self.assertEqual([], listing["problems"])
        self.assertIn("example-application", [item["slug"] for item in listing["applications"]])
        for app in listing["applications"]:
            for doc in app["documents"]:
                if doc["type"] == "block":
                    data = model.load(ROOT / doc["source"])
                    render.render(data, apps.load_profile(ROOT), resolver=build.make_resolver(ROOT, doc["source"]))
                elif doc["type"] == "texts":
                    data = model.load(ROOT / doc["source"])
                    self.assertEqual([], texts.over_limit(data), doc["source"])

    def test_templates_are_valid(self):
        for path in (ROOT / "applications" / "_templates").glob("*.json"):
            model.load(path)
            json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
