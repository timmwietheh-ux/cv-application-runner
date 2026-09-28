---
name: application-workspace
description: Set up and maintain the CV Application Runner, verified facts, application dossiers, attachments and builds.
---

# Application workspace

Read AGENTS.md and Git status before changes. The John Doe example is fictional.

For initial setup, run scripts/bootstrap.py, resolve missing Python or TeX prerequisites, then run scripts/doctor.py --build. Test the local Runner's Create, save, PDF preview and Print & export screens in a browser.

For a real target, read the official call and archive the source and access date under applications/<slug>/source-materials/. Record requirements in target.md. Gather only facts the user confirms or an original document supports. Write those facts with provenance in .agents/memory/cv_facts.md. Put gaps in TODO.md.

Create a new application with the Runner or scripts/cv.py new. Edit its own JSON blocks. Replace the sample shared profile before building real documents. To include certificates, place private PDF files in assets/attachments/certificates/ with the names declared in src/certificates/certificates.tex and rebuild. Keep certificate PDFs and generated outputs out of Git.

Run scripts/cv.py check and targeted builds. Inspect every rendered page, extracted text, page count and any portal character limits. Record meaningful changes in .agents/memory/change_log.md. Before any requested commit or push, review staged file names and contents for private data.
