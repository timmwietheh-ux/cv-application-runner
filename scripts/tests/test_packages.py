"""PDF package order and register boundaries."""
import pathlib
import shutil
import sys
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from cvkit import apps, packages  # noqa: E402


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "applications" / "_templates", self.tmp / "applications" / "_templates")
        shutil.copyfile(ROOT / "applications" / "profile.json", self.tmp / "applications" / "profile.json")
        apps.create_application(self.tmp, "test-app", "Test Application",
                                cv="template:academic-cv", letter="template:cover-letter",
                                texts="template:portal-texts")
        for doc_id, width in (("cv", 120), ("letter", 240)):
            doc = apps.find_document(self.tmp, "test-app", doc_id)
            path = self.tmp / doc["pdf"]
            path.parent.mkdir(parents=True, exist_ok=True)
            writer = PdfWriter()
            writer.add_blank_page(width=width, height=300)
            with path.open("wb") as handle:
                writer.write(handle)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_merge_respects_selection_order(self):
        result = packages.merge(self.tmp, "test-app", ["letter", "cv"])
        reader = PdfReader(str(self.tmp / result["path"]))
        self.assertEqual(2, result["pages"])
        self.assertEqual([240, 120], [float(page.mediabox.width) for page in reader.pages])
        self.assertEqual(self.tmp / result["path"],
                         packages.package_file(self.tmp, "test-app", result["name"]))

    def test_texts_foreign_docs_and_bad_paths_are_rejected(self):
        for ids in ([], ["texts"], ["cv", "cv"], ["../secret"]):
            with self.subTest(ids=ids), self.assertRaises(packages.PackageError):
                packages.selected_documents(self.tmp, "test-app", ids)
        with self.assertRaises(packages.PackageError):
            packages.package_file(self.tmp, "test-app", "../secret.pdf")


if __name__ == "__main__":
    unittest.main()
